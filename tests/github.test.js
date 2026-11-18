'use strict';

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { createDb } = require('../lib/db');
const { createApp } = require('../server');
const { parseKey, encrypt, decrypt, cleanExport, REPO_RE } = require('../lib/github');

test('token encryption round-trips and rejects tampering', () => {
  const key = parseKey(crypto.randomBytes(32).toString('base64'));
  const packed = encrypt(key, 'gho_abc123');
  assert.ok(!packed.includes('gho_abc123'));
  assert.equal(decrypt(key, packed), 'gho_abc123');
  assert.notEqual(encrypt(key, 'gho_abc123'), packed); // fresh IV every time
  assert.throws(() => decrypt(parseKey(crypto.randomBytes(32).toString('base64')), packed));
  const parts = packed.split('.');
  parts[2] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decrypt(key, parts.join('.')));
  assert.equal(parseKey('short'), null);
  assert.equal(parseKey(undefined), null);
});

test('cleanExport validates paths, size and the commit message', () => {
  const ok = { files: { 'main.c': 'int main(){}', 'src/a.h': '#pragma once', 'README.md': '# Hi' } };
  assert.ok(cleanExport(ok).value);
  assert.equal(cleanExport(ok).value.message, 'Update from cc-studio');
  assert.equal(cleanExport({ ...ok, message: '  Fix   bug ' }).value.message, 'Fix bug');
  for (const bad of [null, { files: {} }, { files: { '../x.c': 'a' } }, { files: { 'a.exe': 'a' } }, { files: { 'a.c': 5 } }, { files: { 'a.c': 'x'.repeat(70 * 1024) } }]) {
    assert.ok(cleanExport(bad).error, JSON.stringify(bad).slice(0, 50));
  }
  assert.ok(REPO_RE.test('my-repo.v2') && !REPO_RE.test('..') && !REPO_RE.test('a/b') && !REPO_RE.test(''));
});

/** A tiny in-memory stand-in for the parts of GitHub that cc-studio calls. */
function fakeGithub() {
  const gh = { repos: new Map(), calls: [], revoked: false, polls: 0, scope: 'public_repo' };
  const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
  gh.fetch = async (url, options = {}) => {
    const u = new URL(url);
    const body = options.body ? JSON.parse(options.body) : undefined;
    gh.calls.push({ method: options.method || 'GET', path: u.pathname, body, auth: options.headers && options.headers.Authorization });
    if (u.host === 'github.com' && u.pathname === '/login/device/code') {
      return reply(200, { device_code: 'dc-secret', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 });
    }
    if (u.host === 'github.com' && u.pathname === '/login/oauth/access_token') {
      return reply(200, ++gh.polls < 2 ? { error: 'authorization_pending' } : { access_token: 'gho_secret', token_type: 'bearer', scope: gh.scope });
    }
    if (gh.revoked) return reply(401, { message: 'Bad credentials' });
    const m = /^\/repos\/octo\/([^/]+)(.*)$/.exec(u.pathname);
    if (u.pathname === '/user') return reply(200, { login: 'octo' });
    if (u.pathname === '/user/repos' && (options.method || 'GET') === 'GET') {
      return reply(200, [...gh.repos.entries()].map(([n, r]) => ({ name: n, private: r.private, default_branch: 'main', description: null })));
    }
    if (u.pathname === '/user/repos' && gh.cannotCreate) return reply(403, { message: 'Resource not accessible by integration' });
    if (u.pathname === '/user/repos') {
      gh.repos.set(body.name, { default_branch: 'main', files: {}, treeSha: 't0', commits: ['c0'], private: body.private, autoInit: body.auto_init });
      return reply(201, { default_branch: 'main', html_url: `https://github.com/octo/${body.name}` });
    }
    if (!m) return reply(404, { message: 'Not Found' });
    const repo = gh.repos.get(m[1]);
    if (!repo) return reply(404, { message: 'Not Found' });
    const rest = m[2];
    if (rest === '') return reply(200, { default_branch: 'main', html_url: `https://github.com/octo/${m[1]}` });
    if (rest === '/git/ref/heads/main') return reply(200, { object: { sha: repo.commits[repo.commits.length - 1] } });
    if (/^\/git\/commits\/c\d+$/.test(rest) && (options.method || 'GET') === 'GET') return reply(200, { tree: { sha: repo.treeSha } });
    if (rest === '/git/trees/main' && u.search === '?recursive=1') {
      const entries = Object.entries(repo.files).map(([path, text]) => ({ path, type: 'blob', sha: `blob:${path}`, size: Buffer.byteLength(text) }));
      entries.push({ path: 'README.md', type: 'blob', sha: 'blob:README.md', size: 10 }, { path: 'img/logo.c', type: 'blob', sha: 'blob:img/logo.c', size: 4 }, { path: 'src', type: 'tree', sha: 'x' });
      return reply(200, { sha: repo.treeSha, tree: entries, truncated: false });
    }
    if (rest.startsWith('/git/blobs/')) {
      const p = decodeURIComponent(rest.slice('/git/blobs/'.length)).replace(/^blob:/, '');
      const text = p === 'img/logo.c' ? 'ab\u0000c' : repo.files[p] ?? 'readme';
      return reply(200, { encoding: 'base64', content: Buffer.from(text).toString('base64') });
    }
    if (rest === '/git/trees' && gh.readOnly) return reply(403, { message: 'Resource not accessible by integration' });
    if (rest === '/git/trees') {
      const merged = { ...repo.files };
      for (const e of body.tree) merged[e.path] = e.content;
      const same = JSON.stringify(merged) === JSON.stringify(repo.files);
      repo.pending = { merged, sha: same ? repo.treeSha : `t${repo.commits.length}` };
      return reply(201, { sha: repo.pending.sha });
    }
    if (rest === '/git/commits') {
      repo.pendingCommit = `c${repo.commits.length}`;
      repo.lastMessage = body.message;
      repo.lastParents = body.parents;
      return reply(201, { sha: repo.pendingCommit, html_url: `https://github.com/octo/${m[1]}/commit/${repo.pendingCommit}` });
    }
    if (rest === '/git/refs/heads/main') {
      repo.commits.push(body.sha);
      repo.files = repo.pending.merged;
      repo.treeSha = repo.pending.sha;
      return reply(200, {});
    }
    return reply(404, { message: 'Not Found' });
  };
  return gh;
}

const DB_URL = process.env.DATABASE_URL;
test('GitHub connect and export', { skip: !DB_URL && 'DATABASE_URL not set' }, async (t) => {
  const name = `ccstudio_test_gh_${process.pid}`;
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DB_URL);
  url.pathname = `/${name}`;
  const db = await createDb(url.toString());
  const gh = fakeGithub();
  const tokenKey = crypto.randomBytes(32).toString('base64');
  const listen = async (github) => {
    const server = http.createServer(createApp({ runner: {}, db, logger: { error() {} }, github }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  };
  const on = await listen({ clientId: 'client-id', scope: 'public_repo', tokenKey, fetchImpl: gh.fetch });
  const off = await listen({});
  t.after(async () => { on.server.close(); off.server.close(); await db.close(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); });

  const call = async (base, method, path, body, cookie) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  const me = await call(on.base, 'POST', '/api/signup', { email: 'g@example.com', password: 'password-123' });
  const cookie = me.cookie;
  const api = (method, path, body) => call(on.base, method, `/api/github${path}`, body, cookie);
  const files = { 'main.c': 'int main(void){return 0;}', 'src/util.h': '#pragma once' };

  await t.test('needs a login, and reports when the server has no GitHub app', async () => {
    assert.equal((await call(on.base, 'GET', '/api/github/status')).status, 401);
    const off2 = await call(off.base, 'POST', '/api/signup', { email: 'o@example.com', password: 'password-123' });
    assert.deepEqual((await call(off.base, 'GET', '/api/github/status', undefined, off2.cookie)).json, { enabled: false });
    assert.equal((await call(off.base, 'POST', '/api/github/export', { repo: 'x', files }, off2.cookie)).status, 503);
  });

  await t.test('push and pull before connecting ask to connect', async () => {
    assert.deepEqual((await api('GET', '/status')).json, { enabled: true, connected: false, login: null, repo: null, canBePrivate: false });
    for (const [path, body] of [['/export', { files }], ['/import', {}], ['/repo', null]]) {
      const r = body === null ? await api('PUT', path, { repo: 'proj' }) : await api('POST', path, body);
      assert.equal(r.status, 409, path);
      assert.equal(r.json.needsConnect, true);
    }
  });

  await t.test('device login: code, pending, then connected', async () => {
    assert.equal((await api('POST', '/device/poll', {})).json.status, 'expired'); // nothing started
    const s = await api('POST', '/device/start', {});
    assert.equal(s.json.userCode, 'ABCD-1234');
    assert.equal(s.json.verificationUri, 'https://github.com/login/device');
    assert.ok(!JSON.stringify(s.json).includes('dc-secret')); // the device code never reaches the browser
    assert.deepEqual((await api('POST', '/device/poll', {})).json, { status: 'pending' });
    assert.deepEqual((await api('POST', '/device/poll', {})).json, { status: 'connected', login: 'octo' });
    const st = (await api('GET', '/status')).json;
    assert.deepEqual([st.connected, st.login, st.repo], [true, 'octo', null]);
    const row = (await db.query('SELECT token_enc FROM github_links')).rows[0];
    assert.ok(!row.token_enc.includes('gho_secret')); // stored encrypted
    assert.equal(decrypt(parseKey(tokenKey), row.token_enc), 'gho_secret');
  });

  await t.test('push and pull need a linked repository', async () => {
    for (const [path, body] of [['/export', { files }], ['/import', {}]]) {
      const r = await api('POST', path, body);
      assert.equal(r.status, 409, path);
      assert.equal(r.json.needsRepo, true);
    }
  });

  await t.test('link a repository: must exist, or be created on request', async () => {
    assert.equal((await api('PUT', '/repo', { repo: 'a/b' })).status, 400);
    const missing = await api('PUT', '/repo', { repo: 'proj' });
    assert.equal(missing.status, 404);
    assert.equal(missing.json.canCreate, true);
    assert.equal((await api('GET', '/status')).json.repo, null); // not linked by a failed try

    gh.cannotCreate = true; // GitHub refuses to create the repository
    const refused = await api('PUT', '/repo', { repo: 'proj', create: true });
    assert.equal(refused.status, 400);
    assert.match(refused.json.error, /Create it on GitHub yourself/);
    assert.equal(gh.repos.has('proj'), false);
    gh.cannotCreate = false;

    assert.equal((await api('PUT', '/repo', { repo: 'proj', private: true, create: true })).status, 200);
    assert.equal(gh.repos.get('proj').private, false); // the "repo" scope was not granted, so it stays public
    const linked = (await api('GET', '/status')).json;
    assert.equal(linked.repo, 'proj');
  });

  await t.test('push commits to the linked repository', async () => {
    assert.equal((await api('POST', '/export', { files: { '../x.c': 'a' } })).status, 400);
    const r = await api('POST', '/export', { files, message: 'First version', repo: 'someone-elses' }); // a repo in the body is ignored
    assert.equal(r.status, 200);
    assert.equal(r.json.repo, 'octo/proj');
    assert.equal(r.json.url, 'https://github.com/octo/proj');
    const repo = gh.repos.get('proj');
    assert.deepEqual(repo.files, files);
    assert.equal(repo.lastMessage, 'First version');
    assert.deepEqual(repo.lastParents, ['c0']);
    assert.equal(gh.repos.has('someone-elses'), false);
    assert.ok(gh.calls.filter((c) => c.auth).every((c) => c.auth === 'Bearer gho_secret'));
  });

  await t.test('a refused write gets a clear message', async () => {
    gh.readOnly = true;
    const r = await api('POST', '/export', { files: { ...files, 'main.c': 'changed' } });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /refused to change this repository/);
    gh.readOnly = false;
  });

  await t.test('pushing again: no empty commit when nothing changed, a new commit when it did', async () => {
    const same = await api('POST', '/export', { files });
    assert.equal(same.json.unchanged, true);
    assert.equal(gh.repos.get('proj').commits.length, 2);
    const next = await api('POST', '/export', { files: { ...files, 'main.c': 'int main(void){return 1;}', 'NOTES.md': '# Notes' }, message: 'Fix' });
    assert.equal(next.json.unchanged, false);
    assert.equal(gh.repos.get('proj').commits.length, 3);
    assert.equal(gh.repos.get('proj').files['main.c'], 'int main(void){return 1;}');
    assert.equal(gh.repos.get('proj').files['src/util.h'], '#pragma once'); // untouched files stay
    assert.equal(gh.repos.get('proj').files['NOTES.md'], '# Notes'); // markdown is a supported type
  });

  await t.test('pull: list repositories and fetch the linked repository\'s source files', async () => {
    const list = await api('GET', '/repos');
    assert.equal(list.status, 200);
    assert.deepEqual(list.json.repos.map((r) => r.name), ['proj']);
    const r = await api('POST', '/import', { repo: 'ignored-name' });
    assert.equal(r.status, 200);
    assert.equal(r.json.repo, 'octo/proj');
    assert.equal(r.json.branch, 'main');
    assert.deepEqual(Object.keys(r.json.files).sort(), ['NOTES.md', 'README.md', 'main.c', 'src/util.h']);
    assert.equal(r.json.files['main.c'], 'int main(void){return 1;}');
    assert.equal(r.json.skipped, 1); // logo.c has binary content
  });

  await t.test('pull and list need a connected account; unlinking keeps the connection', async () => {
    const other = await call(on.base, 'POST', '/api/signup', { email: 'h@example.com', password: 'password-123' });
    assert.equal((await call(on.base, 'GET', '/api/github/repos', undefined, other.cookie)).status, 409);
    assert.equal((await call(on.base, 'POST', '/api/github/import', {}, other.cookie)).status, 409);
    assert.equal((await call(on.base, 'POST', '/api/github/import', {})).status, 401);
    assert.equal((await api('DELETE', '/repo')).status, 200);
    const st = (await api('GET', '/status')).json;
    assert.deepEqual([st.connected, st.repo], [true, null]);
    assert.equal((await api('PUT', '/repo', { repo: 'proj' })).status, 200); // relink an existing repo
  });

  await t.test('a token revoked on GitHub unlinks and asks to reconnect', async () => {
    gh.revoked = true;
    const r = await api('POST', '/export', { files });
    assert.equal(r.status, 409);
    assert.equal(r.json.needsConnect, true);
    assert.equal((await api('GET', '/status')).json.connected, false);
    gh.revoked = false;
  });

  await t.test('disconnect removes the saved token and the repository link', async () => {
    gh.polls = 1;
    await api('POST', '/device/start', {});
    assert.equal((await api('POST', '/device/poll', {})).json.status, 'connected');
    assert.equal((await api('DELETE', '')).status, 200);
    assert.equal((await api('GET', '/status')).json.connected, false);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM github_links')).rows[0].n, 0);
  });
});
