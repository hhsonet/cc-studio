'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { createGuards, csrfGuard, createLimiter, parseCookies, publicUser, NO_PASSWORD } = require('./auth');
const { PATH_RE, ALLOWED_EXT, MAX_SOURCE_BYTES } = require('./validate');
const { parseKey, encrypt, decrypt } = require('./crypto');

const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const BLOB_CONCURRENCY = 6;
// A GitHub repository name: letters, digits, . _ - (and not "." or "..").
const REPO_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;

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
function createGithubRouter({ db, settings, tokenKey, fetchImpl = fetch, logger = console }) {
  const router = express.Router();
  const key = parseKey(tokenKey);
  // The GitHub app's settings come from the admin page (or the environment) and can change at any time, so they
  // are read per request. With a client secret (and a callback URL registered at GitHub) users get GitHub's normal
  // "Authorize" page. Without one, the device login (a code typed on github.com) is the fallback.
  async function config() {
    const c = await settings.github();
    const enabled = Boolean(c.clientId && key);
    return { ...c, enabled, webFlow: enabled && Boolean(c.clientSecret) };
  }
  router.use(express.json({ limit: '3mb' }));
  router.use(csrfGuard);
  const { wrap, requireUser, startSession, loadUser } = createGuards(db);

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
  const needEnabled = wrap(async (req, res, next) => {
    req.gh = await config();
    return req.gh.enabled ? next() : res.status(503).json({ error: 'GitHub export is not set up on this server.' });
  });

  router.get('/status', requireUser, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const c = await config();
    if (!c.enabled) return res.json({ enabled: false });
    const link = await linkOf(req.user.id);
    return res.json({ enabled: true, webFlow: c.webFlow, connected: Boolean(link), login: link ? link.github_login : null, repo: link ? link.repo : null, canBePrivate: (link ? link.scope : c.scope).split(/[ ,]+/).includes('repo') });
  }));

  // ---- Connect: GitHub device login ----
  router.post('/device/start', requireUser, needEnabled, wrap(async (req, res) => {
    if (!startLimiter.take(`start:${req.user.id}`)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
    const r = await json('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'cc-studio' },
      body: JSON.stringify({ client_id: req.gh.clientId, scope: req.gh.scope }),
    });
    if (!r.ok || !r.body || !r.body.device_code) {
      logger.error('GitHub device start failed:', r.status, r.body && r.body.error);
      return res.status(502).json({ error: 'GitHub did not start the login. Check that Device Flow is enabled for the OAuth app.' });
    }
    pending.set(String(req.user.id), { deviceCode: r.body.device_code, expiresAt: Date.now() + r.body.expires_in * 1000 });
    return res.json({ userCode: r.body.user_code, verificationUri: r.body.verification_uri, interval: r.body.interval || 5, expiresIn: r.body.expires_in });
  }));

  /** Ask GitHub whether the user has approved the device code yet. */
  async function tokenFromDevice(c, deviceCode) {
    const r = await json('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'cc-studio' },
      body: JSON.stringify({ client_id: c.clientId, device_code: deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' }),
    });
    const body = r.body || {};
    if (body.error === 'authorization_pending') return { status: 'pending' };
    if (body.error === 'slow_down') return { status: 'pending', interval: body.interval };
    if (body.error === 'access_denied') return { status: 'denied' };
    if (body.error || !body.access_token) return { status: 'expired' };
    return { status: 'token', token: body.access_token, scope: body.scope || '' };
  }

  /**
   * Tie a GitHub account to a cc-studio user and keep its (encrypted) token. This GitHub account becomes the
   * one that may sign in as this user: one GitHub account, one cc-studio account.
   * Returns {} or { error, code }.
   */
  async function linkGithubAccount(userId, me, token, tokenScope) {
    try {
      const own = await db.query('UPDATE users SET github_id = $1 WHERE id = $2 AND (github_id IS NULL OR github_id = $1)', [me.id, userId]);
      if (!own.rowCount) return { error: 'This cc-studio account is already tied to a different GitHub account.', code: 'github_other' };
    } catch (err) {
      if (err.code === '23505') return { error: 'That GitHub account already belongs to another cc-studio account.', code: 'github_taken' };
      throw err;
    }
    await db.query(
      `INSERT INTO github_links (user_id, github_login, token_enc, scope) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET github_login = EXCLUDED.github_login, token_enc = EXCLUDED.token_enc, scope = EXCLUDED.scope, created_at = now()`,
      [userId, me.login, encrypt(key, token), tokenScope]);
    return {};
  }

  router.post('/device/poll', requireUser, needEnabled, wrap(async (req, res) => {
    const entry = pending.get(String(req.user.id));
    if (!entry || entry.expiresAt < Date.now()) { pending.delete(String(req.user.id)); return res.json({ status: 'expired' }); }
    const t = await tokenFromDevice(req.gh, entry.deviceCode);
    if (t.status === 'pending') return res.json(t.interval ? { status: 'pending', interval: t.interval } : { status: 'pending' });
    if (t.status !== 'token') { pending.delete(String(req.user.id)); return res.json({ status: t.status }); }

    const me = await api(t.token, 'GET', '/user');
    if (!me.ok || !me.body || !me.body.login || !me.body.id) return res.status(502).json({ error: 'Connected, but GitHub would not say who you are. Try again.' });
    const linked = await linkGithubAccount(req.user.id, me.body, t.token, t.scope);
    if (linked.error) return res.status(409).json({ error: linked.error });
    pending.delete(String(req.user.id));
    return res.json({ status: 'connected', login: me.body.login });
  }));

  // ---- Sign in with GitHub: works before there is an account, so it is public (and rate limited) ----
  const loginStartLimiter = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });
  const loginPollLimiter = createLimiter({ max: 300, windowMs: 15 * 60 * 1000 });
  const loginPending = new Map(); // secret login id (held only by that browser) -> { deviceCode, expiresAt }

  /** The cc-studio user for a GitHub account: the one linked to it, or a new student account named after it. */
  async function userForGithub(ghId, ghLogin) {
    const find = async () => (await db.query('SELECT id FROM users WHERE github_id = $1', [ghId])).rows[0];
    const known = await find();
    if (known) return known.id;
    let base = String(ghLogin).replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 28) || 'github-user';
    if (base.length < 2) base = `${base}-gh`;
    for (let i = 1; i <= 25; i++) {
      const username = i === 1 ? base : `${base}-${i}`;
      try {
        // Never merge into an existing account by name or email: a taken name just gets a suffix.
        const { rows } = await db.query('INSERT INTO users (username, password_hash, github_id) VALUES ($1, $2, $3) RETURNING id', [username, NO_PASSWORD, ghId]);
        return rows[0].id;
      } catch (err) {
        if (err.code !== '23505') throw err;
        const raced = await find(); // two sign-ins at once for the same GitHub account
        if (raced) return raced.id;
      }
    }
    throw new Error('Could not find a free username.');
  }

  // ---- Web OAuth: GitHub's own "Authorize cc-studio" page, then back here signed in ----
  const OAUTH_COOKIE = 'cc_gh_oauth';
  const oauthCookie = (req, maxAge) => ({ httpOnly: true, sameSite: 'lax', secure: req.secure, path: '/api/github', maxAge });
  const callbackUrl = (req) => `${(req.gh.publicUrl || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')}/api/github/oauth/callback`;
  const needWebFlow = wrap(async (req, res, next) => {
    req.gh = await config();
    return req.gh.webFlow ? next() : res.status(503).json({ error: 'GitHub sign-in is not set up on this server.' });
  });

  /** Send the browser to GitHub. The random state, kept in a cookie, proves the answer belongs to this browser. */
  function sendToGithub(req, res, mode, wantedScope) {
    const state = crypto.randomBytes(24).toString('base64url');
    res.cookie(OAUTH_COOKIE, `${state}.${mode}`, oauthCookie(req, 10 * 60 * 1000));
    const q = new URLSearchParams({ client_id: req.gh.clientId, redirect_uri: callbackUrl(req), state, allow_signup: 'true' });
    if (wantedScope) q.set('scope', wantedScope);
    res.set('Cache-Control', 'no-store');
    res.redirect(`https://github.com/login/oauth/authorize?${q}`);
  }

  // Sign in: asks only for the public profile.
  router.get('/oauth/login', needWebFlow, (req, res) => sendToGithub(req, res, 'login', ''));

  // Connect for push and pull (signed-in users): asks for the repository permission.
  router.get('/oauth/connect', needWebFlow, wrap(async (req, res) => {
    const user = await loadUser(req);
    if (!user) return res.redirect('/?auth=login_first');
    return sendToGithub(req, res, 'connect', req.gh.scope);
  }));

  router.get('/oauth/callback', needWebFlow, wrap(async (req, res) => {
    const [state, mode] = String(parseCookies(req.headers.cookie)[OAUTH_COOKIE] || '').split('.');
    res.clearCookie(OAUTH_COOKIE, oauthCookie(req, undefined));
    res.set('Cache-Control', 'no-store');
    const back = (code) => res.redirect(mode === 'connect' ? `/profile?auth=${code}#github` : `/?auth=${code}`);
    if (req.query.error) return back('github_denied');
    const { code, state: returned } = req.query;
    if (!state || (mode !== 'login' && mode !== 'connect') || typeof returned !== 'string' || returned !== state || typeof code !== 'string' || !code) return back('github_state');
    if (!loginPollLimiter.take(`cb:${req.ip}`)) return back('github_failed');

    const r = await json('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'cc-studio' },
      body: JSON.stringify({ client_id: req.gh.clientId, client_secret: req.gh.clientSecret, code, redirect_uri: callbackUrl(req) }),
    });
    const token = r.body && r.body.access_token;
    if (!token) return back('github_failed');
    const me = await api(token, 'GET', '/user');
    if (!me.ok || !me.body || !me.body.login || !me.body.id) return back('github_failed');

    if (mode === 'login') {
      await startSession(req, res, await userForGithub(me.body.id, me.body.login)); // the token is used once, here, and not kept
      return res.redirect('/');
    }
    const user = await loadUser(req);
    if (!user) return back('login_first');
    const linked = await linkGithubAccount(user.id, me.body, token, r.body.scope || '');
    return linked.error ? back(linked.code) : res.redirect('/profile#github');
  }));

  router.get('/login/status', wrap(async (req, res) => {
    const c = await config();
    res.json({ enabled: c.enabled, webFlow: c.webFlow });
  }));

  router.post('/login/start', needEnabled, wrap(async (req, res) => {
    if (!loginStartLimiter.take(`start:${req.ip}`)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
    const now = Date.now();
    for (const [id, e] of loginPending) if (e.expiresAt < now) loginPending.delete(id);
    if (loginPending.size >= 2000) return res.status(503).json({ error: 'Busy right now. Try again in a minute.' });
    // No scope: signing in only needs to know who you are (your public GitHub profile).
    const r = await json('https://github.com/login/device/code', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'cc-studio' },
      body: JSON.stringify({ client_id: req.gh.clientId }),
    });
    if (!r.ok || !r.body || !r.body.device_code) {
      logger.error('GitHub sign-in start failed:', r.status, r.body && r.body.error);
      return res.status(502).json({ error: 'GitHub did not start the sign-in. Try again in a moment.' });
    }
    const loginId = crypto.randomBytes(24).toString('base64url');
    loginPending.set(loginId, { deviceCode: r.body.device_code, expiresAt: now + r.body.expires_in * 1000 });
    return res.json({ loginId, userCode: r.body.user_code, verificationUri: r.body.verification_uri, interval: r.body.interval || 5, expiresIn: r.body.expires_in });
  }));

  router.post('/login/poll', needEnabled, wrap(async (req, res) => {
    if (!loginPollLimiter.take(`poll:${req.ip}`)) return res.status(429).json({ error: 'Too many requests. Wait a few minutes.' });
    const id = req.body && req.body.loginId;
    const entry = typeof id === 'string' ? loginPending.get(id) : null;
    if (!entry || entry.expiresAt < Date.now()) { loginPending.delete(id); return res.json({ status: 'expired' }); }
    const t = await tokenFromDevice(req.gh, entry.deviceCode);
    if (t.status === 'pending') return res.json(t.interval ? { status: 'pending', interval: t.interval } : { status: 'pending' });
    loginPending.delete(id);
    if (t.status !== 'token') return res.json({ status: t.status });

    const me = await api(t.token, 'GET', '/user'); // the token is used once, here, and not kept
    if (!me.ok || !me.body || !me.body.login || !me.body.id) return res.status(502).json({ error: 'GitHub would not say who you are. Try again.' });
    const userId = await userForGithub(me.body.id, me.body.login);
    await startSession(req, res, userId);
    const { rows } = await db.query('SELECT id, email, username, full_name, student_id, role, created_at, (password_hash <> $2) AS has_password FROM users WHERE id = $1', [userId, NO_PASSWORD]);
    return res.json({ status: 'connected', user: publicUser(rows[0]) });
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

  // ---- History: the linked repository's latest commits (read-only) ----
  const historyLimiter = createLimiter({ max: 60, windowMs: 10 * 60 * 1000 });

  router.get('/commits', requireUser, needEnabled, wrap(async (req, res) => {
    if (!historyLimiter.take(`history:${req.user.id}`)) return res.status(429).json({ error: 'Too many refreshes. Wait a minute.' });
    const auth = await tokenFor(req, res);
    if (!auth) return null;
    const repo = linkedRepo(res, auth);
    if (!repo) return null;
    const login = auth.link.github_login;
    const r = await api(auth.token, 'GET', `/repos/${encodeURIComponent(login)}/${encodeURIComponent(repo)}/commits?per_page=20`);
    if (r.status === 401) return answerError(req, res, unauthorised());
    res.set('Cache-Control', 'no-store');
    if (r.status === 409) return res.json({ repo: `${login}/${repo}`, commits: [], empty: true });
    if (r.status === 404) return res.status(404).json({ error: `The linked repository "${repo}" was not found. Link it again in your profile.` });
    if (!r.ok || !Array.isArray(r.body)) return res.status(502).json({ error: 'Could not read the commit history from GitHub.' });
    return res.json({
      repo: `${login}/${repo}`,
      commits: r.body.map((c) => ({
        sha: String(c.sha).slice(0, 7),
        fullSha: String(c.sha),
        message: String((c.commit && c.commit.message) || '').split('\n')[0].slice(0, 200),
        author: (c.author && c.author.login) || (c.commit && c.commit.author && c.commit.author.name) || 'unknown',
        date: (c.commit && c.commit.author && c.commit.author.date) || null,
        url: c.html_url || null,
      })),
    });
  }));

  // What one commit changed, for the file tree under each commit in the Git tab (read-only).
  const detailLimiter = createLimiter({ max: 120, windowMs: 10 * 60 * 1000 });
  const MAX_CHANGED_FILES = 300; // GitHub itself stops listing at 300
  const CHANGE_STATUS = new Set(['added', 'removed', 'modified', 'renamed']);

  router.get('/commits/:sha', requireUser, needEnabled, wrap(async (req, res) => {
    if (!/^[0-9a-f]{7,40}$/i.test(req.params.sha)) return res.status(400).json({ error: 'That is not a commit id.' });
    if (!detailLimiter.take(`commit:${req.user.id}`)) return res.status(429).json({ error: 'Too many requests. Wait a minute.' });
    const auth = await tokenFor(req, res);
    if (!auth) return null;
    const repo = linkedRepo(res, auth);
    if (!repo) return null;
    const login = auth.link.github_login;
    const r = await api(auth.token, 'GET', `/repos/${encodeURIComponent(login)}/${encodeURIComponent(repo)}/commits/${req.params.sha}`);
    if (r.status === 401) return answerError(req, res, unauthorised());
    if (r.status === 404 || r.status === 422) return res.status(404).json({ error: 'That commit was not found in the linked repository.' });
    if (!r.ok || !r.body) return res.status(502).json({ error: 'Could not read that commit from GitHub.' });
    const all = Array.isArray(r.body.files) ? r.body.files : [];
    res.set('Cache-Control', 'private, max-age=300'); // a commit never changes
    return res.json({
      sha: String(r.body.sha || req.params.sha).slice(0, 7),
      message: String((r.body.commit && r.body.commit.message) || '').slice(0, 4000),
      additions: Number(r.body.stats && r.body.stats.additions) || 0,
      deletions: Number(r.body.stats && r.body.stats.deletions) || 0,
      total: all.length,
      files: all.slice(0, MAX_CHANGED_FILES).map((f) => ({
        path: String(f.filename),
        status: CHANGE_STATUS.has(f.status) ? f.status : 'modified',
        additions: Number(f.additions) || 0,
        deletions: Number(f.deletions) || 0,
        ...(f.previous_filename ? { from: String(f.previous_filename) } : {}),
      })),
    });
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

module.exports = { createGithubRouter, parseKey, encrypt, decrypt, cleanExport, REPO_RE }; // the crypto helpers live in ./crypto; re-exported for convenience
