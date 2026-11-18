'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { createGuards, csrfGuard, createLimiter } = require('./auth');
const { PATH_RE, ALLOWED_EXT, MAX_SOURCE_BYTES } = require('./validate');

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const BLOB_CONCURRENCY = 6;
// A GitHub repository name: letters, digits, . _ - (and not "." or "..").
const REPO_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

// ---- Token encryption at rest: AES-256-GCM, stored as "iv.tag.ciphertext" (base64) ----

/** The 32-byte key from a base64 string, or null if it is missing or the wrong size. */
function parseKey(b64) {
  const key = Buffer.from(b64 || '', 'base64');
  return key.length === 32 ? key : null;
}

function encrypt(key, text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(key, packed) {
  const [iv, tag, enc] = String(packed).split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

/** Check a push request body (the repository itself comes from the user's profile). Returns { value } or { error }. */
function cleanExport(body) {
  const b = body && typeof body === 'object' ? body : {};
  if (!b.files || typeof b.files !== 'object' || Array.isArray(b.files)) return { error: 'files must be an object.' };
  const paths = Object.keys(b.files);
  if (paths.length === 0 || paths.length > MAX_FILES) return { error: `Export 1 to ${MAX_FILES} files.` };
  let total = 0;
  for (const p of paths) {
    if (!PATH_RE.test(p) || !ALLOWED_EXT.test(p)) return { error: `Invalid file name "${p.slice(0, 40)}".` };
    if (typeof b.files[p] !== 'string') return { error: `File "${p}" must be text.` };
    const n = Buffer.byteLength(b.files[p], 'utf8');
    if (n > MAX_SOURCE_BYTES) return { error: `File "${p}" is larger than 64 KB.` };
    total += n;
  }
  if (total > MAX_TOTAL_BYTES) return { error: 'The export is larger than 2 MB.' };
  const message = (typeof b.message === 'string' ? b.message.trim().replace(/\s+/g, ' ').slice(0, 200) : '') || 'Update from cc-studio';
  return { value: { files: b.files, message } };
}

class GithubError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

/**
 * GitHub for cc-studio under /api/github: connect an account with the device login flow (no client
 * secret and no redirect URL), then export a project into one of the user's repositories as a single commit.
 * `fetchImpl` is injectable so tests never talk to GitHub.
 */
function createGithubRouter({ db, clientId, scope = 'public_repo', tokenKey, fetchImpl = fetch, logger = console }) {
  const router = express.Router();
  const key = parseKey(tokenKey);
  const enabled = Boolean(clientId && key);
  router.use(express.json({ limit: '3mb' }));
  router.use(csrfGuard);
  const { wrap, requireUser } = createGuards(db);

  const startLimiter = createLimiter({ max: 6, windowMs: 10 * 60 * 1000 });
  const exportLimiter = createLimiter({ max: 20, windowMs: 10 * 60 * 1000 });
  const pending = new Map(); // user id -> { deviceCode, expiresAt }

  async function json(url, options) {
    const res = await fetchImpl(url, options);
    let body = null;
    try { body = await res.json(); } catch { /* empty body */ }
    return { status: res.status, ok: res.ok, body };
  }

  const api = (token, method, path, payload) => json(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'cc-studio',
      ...(payload && { 'Content-Type': 'application/json' }),
    },
    body: payload ? JSON.stringify(payload) : undefined,
  });

  const linkOf = async (userId) => (await db.query('SELECT github_login, token_enc, scope, repo FROM github_links WHERE user_id = $1', [userId])).rows[0];
  const needEnabled = (req, res, next) => (enabled ? next() : res.status(503).json({ error: 'GitHub export is not set up on this server.' }));

  router.get('/status', requireUser, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!enabled) return res.json({ enabled: false });
    const link = await linkOf(req.user.id);
    return res.json({ enabled: true, connected: Boolean(link), login: link ? link.github_login : null, repo: link ? link.repo : null, canBePrivate: (link ? link.scope : scope).split(/[ ,]+/).includes('repo') });
  }));

  // ---- Connect: GitHub device login ----
  router.post('/device/start', requireUser, needEnabled, wrap(async (req, res) => {
    if (!startLimiter.take(`start:${req.user.id}`)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
    const r = await json('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'cc-studio' },
      body: JSON.stringify({ client_id: clientId, scope }),
    });
    if (!r.ok || !r.body || !r.body.device_code) {
      logger.error('GitHub device start failed:', r.status, r.body && r.body.error);
      return res.status(502).json({ error: 'GitHub did not start the login. Check that Device Flow is enabled for the OAuth app.' });
    }
    pending.set(String(req.user.id), { deviceCode: r.body.device_code, expiresAt: Date.now() + r.body.expires_in * 1000 });
    return res.json({ userCode: r.body.user_code, verificationUri: r.body.verification_uri, interval: r.body.interval || 5, expiresIn: r.body.expires_in });
  }));

  router.post('/device/poll', requireUser, needEnabled, wrap(async (req, res) => {
    const entry = pending.get(String(req.user.id));
    if (!entry || entry.expiresAt < Date.now()) { pending.delete(String(req.user.id)); return res.json({ status: 'expired' }); }
    const r = await json('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'cc-studio' },
      body: JSON.stringify({ client_id: clientId, device_code: entry.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    const body = r.body || {};
    if (body.error === 'authorization_pending') return res.json({ status: 'pending' });
    if (body.error === 'slow_down') return res.json({ status: 'pending', interval: body.interval });
    if (body.error === 'access_denied') { pending.delete(String(req.user.id)); return res.json({ status: 'denied' }); }
    if (body.error || !body.access_token) { pending.delete(String(req.user.id)); return res.json({ status: 'expired' }); }

    const me = await api(body.access_token, 'GET', '/user');
    if (!me.ok || !me.body || !me.body.login) return res.status(502).json({ error: 'Connected, but GitHub would not say who you are. Try again.' });
    await db.query(
      `INSERT INTO github_links (user_id, github_login, token_enc, scope) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET github_login = EXCLUDED.github_login, token_enc = EXCLUDED.token_enc, scope = EXCLUDED.scope, created_at = now()`,
      [req.user.id, me.body.login, encrypt(key, body.access_token), body.scope || '']);
    pending.delete(String(req.user.id));
    return res.json({ status: 'connected', login: me.body.login });
  }));

  // Forget the saved token here. (Revoking it on GitHub itself is done in GitHub's settings.)
  router.delete('/', requireUser, wrap(async (req, res) => {
    await db.query('DELETE FROM github_links WHERE user_id = $1', [req.user.id]);
    pending.delete(String(req.user.id));
    res.json({ ok: true });
  }));

  // ---- The user's one repository: link it (optionally creating it), then push and pull against it ----
  async function ensureRepo(token, login, repo, { create, isPrivate }) {
    const base = `/repos/${encodeURIComponent(login)}/${encodeURIComponent(repo)}`;
    const info = await api(token, 'GET', base);
    if (info.ok) return { url: info.body.html_url, created: false };
    if (info.status === 401) throw new GithubError(401, 'GitHub no longer accepts the saved login. Connect again.');
    if (info.status !== 404) throw new GithubError(502, `Could not open the repository: ${(info.body && info.body.message) || `GitHub answered ${info.status}`}`);
    if (!create) {
      throw new GithubError(404, `No repository called "${repo}" was found on your GitHub account. Check the name, or let cc-studio create it.`, { canCreate: true });
    }
    const made = await api(token, 'POST', '/user/repos', { name: repo, private: isPrivate, auto_init: true });
    if (made.status === 403) {
      throw new GithubError(400, `GitHub would not let cc-studio create "${repo}": ${(made.body && made.body.message) || 'forbidden'}. Create it on GitHub yourself, then link it.`);
    }
    if (made.status === 401) throw new GithubError(401, 'GitHub no longer accepts the saved login. Connect again.');
    if (!made.ok) throw new GithubError(made.status === 422 ? 400 : 502, `Could not create the repository: ${(made.body && made.body.message) || `GitHub answered ${made.status}`}`);
    return { url: made.body.html_url, created: true };
  }

  async function pushToRepo(token, login, repo, { files, message }) {
    const fail = (r, what) => {
      if (r.status === 401) throw unauthorised();
      if (r.status === 403) {
        throw new GithubError(400, `GitHub refused to change this repository: ${(r.body && r.body.message) || 'forbidden'}. If it belongs to an organization, the organization may need to approve cc-studio (GitHub Settings > Applications > Authorized OAuth Apps).`);
      }
      throw new GithubError(502, `${what}: ${(r.body && r.body.message) || `GitHub answered ${r.status}`}`);
    };
    const base = `/repos/${encodeURIComponent(login)}/${encodeURIComponent(repo)}`;
    const info = await api(token, 'GET', base);
    if (info.status === 404) throw new GithubError(404, `The linked repository "${repo}" was not found. Link it again in your profile.`);
    if (!info.ok) fail(info, 'Could not open the repository');
    const branch = info.body.default_branch || 'main';
    const ref = await api(token, 'GET', `${base}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (ref.status === 404 || ref.status === 409) throw new GithubError(400, 'That repository is empty. Add a README on GitHub first.');
    if (!ref.ok) fail(ref, 'Could not read the repository');
    const parent = ref.body.object.sha;
    const head = await api(token, 'GET', `${base}/git/commits/${parent}`);
    if (!head.ok) fail(head, 'Could not read the latest commit');

    const tree = await api(token, 'POST', `${base}/git/trees`, {
      base_tree: head.body.tree.sha,
      tree: Object.entries(files).map(([path, content]) => ({ path, mode: '100644', type: 'blob', content })),
    });
    if (!tree.ok) fail(tree, 'Could not add the files');
    if (tree.body.sha === head.body.tree.sha) return { url: info.body.html_url, unchanged: true };

    const commit = await api(token, 'POST', `${base}/git/commits`, { message, tree: tree.body.sha, parents: [parent] });
    if (!commit.ok) fail(commit, 'Could not save the commit');
    const move = await api(token, 'PATCH', `${base}/git/refs/heads/${encodeURIComponent(branch)}`, { sha: commit.body.sha });
    if (!move.ok) fail(move, 'Could not update the branch');
    return { url: info.body.html_url, unchanged: false, commitUrl: commit.body.html_url };
  }

  /** The signed-in user's GitHub token, or null after answering "connect first". */
  async function tokenFor(req, res) {
    const link = await linkOf(req.user.id);
    if (!link) { res.status(409).json({ error: 'Connect your GitHub account first.', needsConnect: true }); return null; }
    try {
      return { token: decrypt(key, link.token_enc), link };
    } catch {
      await db.query('DELETE FROM github_links WHERE user_id = $1', [req.user.id]); // unreadable (key changed): start over
      res.status(409).json({ error: 'Your saved GitHub login could not be read. Connect again.', needsConnect: true });
      return null;
    }
  }

  /** Answer a failed GitHub call. A 401 means the token was revoked on GitHub: unlink and ask to reconnect. */
  async function answerError(req, res, err) {
    if (!(err instanceof GithubError)) throw err;
    if (err.status === 401) {
      await db.query('DELETE FROM github_links WHERE user_id = $1', [req.user.id]);
      return res.status(409).json({ error: err.message, needsConnect: true });
    }
    return res.status(err.status).json({ error: err.message, ...err.extra });
  }

  const unauthorised = () => new GithubError(401, 'GitHub no longer accepts the saved login. Connect again.');

  router.put('/repo', requireUser, needEnabled, wrap(async (req, res) => {
    const { repo, create, private: wantPrivate } = req.body || {};
    if (typeof repo !== 'string' || !REPO_RE.test(repo)) return res.status(400).json({ error: 'Repository names use letters, digits, . _ - only (up to 100 characters).' });
    const auth = await tokenFor(req, res);
    if (!auth) return null;
    try {
      const out = await ensureRepo(auth.token, auth.link.github_login, repo, { create: create === true, isPrivate: wantPrivate === true && auth.link.scope.split(/[ ,]+/).includes('repo') });
      await db.query('UPDATE github_links SET repo = $2 WHERE user_id = $1', [req.user.id, repo]);
      return res.json({ ok: true, repo, fullName: `${auth.link.github_login}/${repo}`, ...out });
    } catch (err) {
      return answerError(req, res, err);
    }
  }));

  router.delete('/repo', requireUser, wrap(async (req, res) => {
    await db.query('UPDATE github_links SET repo = NULL WHERE user_id = $1', [req.user.id]);
    res.json({ ok: true });
  }));

  /** The linked repository, or null after answering "link one first". */
  const linkedRepo = (res, auth) => {
    if (auth.link.repo) return auth.link.repo;
    res.status(409).json({ error: 'Link a repository in your profile first.', needsRepo: true });
    return null;
  };

  router.post('/export', requireUser, needEnabled, wrap(async (req, res) => {
    if (!exportLimiter.take(`export:${req.user.id}`)) return res.status(429).json({ error: 'Too many pushes. Wait a few minutes.' });
    const auth = await tokenFor(req, res);
    if (!auth) return null;
    const repo = linkedRepo(res, auth);
    if (!repo) return null;
    const c = cleanExport(req.body);
    if (c.error) return res.status(400).json({ error: c.error });
    try {
      const out = await pushToRepo(auth.token, auth.link.github_login, repo, c.value);
      return res.json({ ok: true, ...out, repo: `${auth.link.github_login}/${repo}` });
    } catch (err) {
      return answerError(req, res, err);
    }
  }));

  // ---- Pull: list the user's repositories, and fetch one repository's source files ----
  router.get('/repos', requireUser, needEnabled, wrap(async (req, res) => {
    const auth = await tokenFor(req, res);
    if (!auth) return null;
    const r = await api(auth.token, 'GET', '/user/repos?affiliation=owner&sort=pushed&per_page=100');
    if (r.status === 401) return answerError(req, res, unauthorised());
    if (!r.ok || !Array.isArray(r.body)) return res.status(502).json({ error: 'Could not list your repositories.' });
    res.set('Cache-Control', 'no-store');
    return res.json({ repos: r.body.map((x) => ({ name: x.name, private: Boolean(x.private), defaultBranch: x.default_branch, description: x.description || '' })) });
  }));

  async function importRepo(token, login, repo, wantedBranch) {
    const fail = (r, what) => {
      if (r.status === 401) throw unauthorised();
      throw new GithubError(502, `${what}: ${(r.body && r.body.message) || `GitHub answered ${r.status}`}`);
    };
    const base = `/repos/${encodeURIComponent(login)}/${encodeURIComponent(repo)}`;
    const info = await api(token, 'GET', base);
    if (info.status === 404) throw new GithubError(404, `No repository called "${repo}" was found on your GitHub account. Link it again in your profile.`);
    if (!info.ok) fail(info, 'Could not open the repository');
    const branch = wantedBranch || info.body.default_branch || 'main';
    const tree = await api(token, 'GET', `${base}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if (tree.status === 404 || tree.status === 409) throw new GithubError(400, wantedBranch ? `The repository has no branch called "${branch}".` : 'That repository is empty.');
    if (!tree.ok) fail(tree, 'Could not read the repository');

    const blobs = (tree.body.tree || []).filter((e) => e.type === 'blob');
    const wanted = blobs.filter((e) => PATH_RE.test(e.path) && ALLOWED_EXT.test(e.path) && e.size <= MAX_SOURCE_BYTES);
    if (wanted.length === 0) throw new GithubError(400, 'That repository has no .c, .cpp, .h, .txt or .md files that cc-studio can open.');
    if (wanted.length > MAX_FILES) throw new GithubError(400, `That repository has ${wanted.length} source files. cc-studio can open at most ${MAX_FILES}.`);
    if (wanted.reduce((n, e) => n + e.size, 0) > MAX_TOTAL_BYTES) throw new GithubError(400, 'The source files are larger than 2 MB in total.');

    const files = {};
    let skipped = blobs.length - wanted.length;
    let next = 0;
    async function worker() {
      while (next < wanted.length) {
        const entry = wanted[next++];
        const blob = await api(token, 'GET', `${base}/git/blobs/${encodeURIComponent(entry.sha)}`);
        if (!blob.ok) fail(blob, `Could not read ${entry.path}`);
        const text = Buffer.from(blob.body.content || '', 'base64').toString('utf8');
        if (text.includes('\u0000')) skipped++; else files[entry.path] = text;
      }
    }
    await Promise.all(Array.from({ length: Math.min(BLOB_CONCURRENCY, wanted.length) }, worker));
    return { repo: `${login}/${repo}`, branch, files, skipped, truncated: Boolean(tree.body.truncated) };
  }

  router.post('/import', requireUser, needEnabled, wrap(async (req, res) => {
    if (!exportLimiter.take(`import:${req.user.id}`)) return res.status(429).json({ error: 'Too many pulls. Wait a few minutes.' });
    const auth = await tokenFor(req, res);
    if (!auth) return null;
    const repo = linkedRepo(res, auth);
    if (!repo) return null;
    try {
      return res.json({ ok: true, ...(await importRepo(auth.token, auth.link.github_login, repo, '')) });
    } catch (err) {
      return answerError(req, res, err);
    }
  }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Too much data.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    logger.error('GitHub route error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  });

  return router;
}

module.exports = { createGithubRouter, parseKey, encrypt, decrypt, cleanExport, REPO_RE };
