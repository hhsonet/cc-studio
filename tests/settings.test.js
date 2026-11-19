'use strict';

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { createDb } = require('../lib/db');
const { createApp } = require('../server');
const { hashPassword } = require('../lib/auth');
const { normalizePublicUrl } = require('../lib/settings');

test('public addresses are reduced to a safe origin', () => {
  assert.equal(normalizePublicUrl('https://cc.example.com/a/b?x=1#y'), 'https://cc.example.com');
  assert.equal(normalizePublicUrl('https://cc.example.com:8443/'), 'https://cc.example.com:8443');
  assert.equal(normalizePublicUrl('http://localhost:3100/x'), 'http://localhost:3100');
  assert.equal(normalizePublicUrl(''), '');
  for (const bad of ['http://cc.example.com', 'ftp://x.com', 'javascript:alert(1)', 'not a url', 'https://user:pw@cc.example.com']) assert.equal(normalizePublicUrl(bad), null, bad);
});

const DB_URL = process.env.DATABASE_URL;
test('admin settings: save GitHub app values at run time', { skip: !DB_URL && 'DATABASE_URL not set' }, async (t) => {
  const name = `ccstudio_test_set_${process.pid}`;
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DB_URL);
  url.pathname = `/${name}`;
  const db = await createDb(url.toString());
  const tokenKey = crypto.randomBytes(32).toString('base64');
  let githubAnswer = { device_code: 'dc', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 5 };
  const fetchImpl = async () => ({ status: 200, ok: true, json: async () => githubAnswer });
  const listen = async (github) => {
    const server = http.createServer(createApp({ runner: {}, db, logger: { error() {} }, github }));
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { server, base: `http://127.0.0.1:${server.address().port}` };
  };
  const app = await listen({ tokenKey, fetchImpl });
  const noKey = await listen({});
  t.after(async () => { app.server.close(); noKey.server.close(); await db.close(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); });

  const call = async (base, method, path, body, cookie) => {
    const res = await fetch(base + path, { method, redirect: 'manual', headers: { 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* a redirect has no body */ }
    return { status: res.status, json, text, location: res.headers.get('location'), cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  await db.query("INSERT INTO users (username, password_hash, role) VALUES ('boss', $1, 'superadmin')", [await hashPassword('boss-password-1')]);
  const boss = (await call(app.base, 'POST', '/api/login', { email: 'boss', password: 'boss-password-1' })).cookie;
  const student = (await call(app.base, 'POST', '/api/signup', { email: 's@example.com', password: 'password-123', fullName: 'Test User' })).cookie;
  const bossNoKey = (await call(noKey.base, 'POST', '/api/login', { email: 'boss', password: 'boss-password-1' })).cookie;
  const SECRET = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  const settings = (method, body, cookie = boss, base = app.base, path = '') => call(base, method, `/api/admin/settings/github${path}`, body, cookie);

  await t.test('only a super admin may read or change them', async () => {
    assert.equal((await settings('GET', undefined, null)).status, 401);
    assert.equal((await settings('GET', undefined, student)).status, 403);
    assert.equal((await settings('PUT', { clientId: 'Ov23liSomething123' }, student)).status, 403);
    assert.equal((await settings('POST', {}, student, app.base, '/check')).status, 403);
  });

  await t.test('nothing is set at first', async () => {
    const r = await settings('GET');
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.clientId, r.json.hasSecret, r.json.publicUrl, r.json.scope], ['', false, '', 'public_repo']);
    assert.deepEqual(Object.values(r.json.sources), ['none', 'none', 'none', 'none']);
    assert.equal((await call(app.base, 'GET', '/api/github/login/status')).json.enabled, false);
  });

  await t.test('values are validated', async () => {
    for (const bad of [{ clientId: 'bad id!' }, { clientId: 5 }, { publicUrl: 'http://example.com' }, { publicUrl: 'nope' }, { scope: 'admin' }, { clientSecret: 'short' }, { clientSecret: 'has space in it 1234567890' }]) {
      assert.equal((await settings('PUT', bad)).status, 400, JSON.stringify(bad));
    }
  });

  await t.test('saving takes effect right away, with no restart', async () => {
    const r = await settings('PUT', { clientId: 'Ov23liExampleClientId', clientSecret: SECRET, publicUrl: 'https://cc.example.com/ignored/path', scope: 'public_repo' });
    assert.equal(r.status, 200);
    assert.deepEqual([r.json.clientId, r.json.hasSecret, r.json.publicUrl], ['Ov23liExampleClientId', true, 'https://cc.example.com']);
    assert.equal(r.json.callbackUrl, 'https://cc.example.com/api/github/oauth/callback');
    assert.equal(r.json.callbackIsGuess, false);
    assert.ok(!r.text.includes(SECRET)); // the secret is never sent back
    assert.ok(!(await settings('GET')).text.includes(SECRET));
    assert.deepEqual(Object.values(r.json.sources), ['database', 'database', 'database', 'database']);

    assert.deepEqual((await call(app.base, 'GET', '/api/github/login/status')).json, { enabled: true, webFlow: true });
    const go = await call(app.base, 'GET', '/api/github/oauth/login');
    assert.equal(go.status, 302);
    const to = new URL(go.location);
    assert.equal(to.searchParams.get('client_id'), 'Ov23liExampleClientId');
    assert.equal(to.searchParams.get('redirect_uri'), 'https://cc.example.com/api/github/oauth/callback');
  });

  await t.test('the secret is encrypted in the database', async () => {
    const row = (await db.query("SELECT value, secret FROM app_settings WHERE key = 'github.client_secret'")).rows[0];
    assert.equal(row.secret, true);
    assert.ok(!row.value.includes(SECRET));
    const id = (await db.query("SELECT value, secret FROM app_settings WHERE key = 'github.client_id'")).rows[0];
    assert.deepEqual([id.value, id.secret], ['Ov23liExampleClientId', false]);
  });

  await t.test('leaving the secret out keeps it; clearing removes it and drops back to the typed code', async () => {
    const keep = await settings('PUT', { clientId: 'Ov23liAnotherClientId' });
    assert.equal(keep.json.hasSecret, true);
    assert.equal(keep.json.clientId, 'Ov23liAnotherClientId');
    assert.equal((await settings('PUT', { clientSecret: '' })).json.hasSecret, true); // an empty box means "unchanged"
    const cleared = await settings('PUT', { clearSecret: true });
    assert.equal(cleared.json.hasSecret, false);
    assert.deepEqual((await call(app.base, 'GET', '/api/github/login/status')).json, { enabled: true, webFlow: false });
    assert.equal((await call(app.base, 'GET', '/api/github/oauth/login')).status, 503);
  });

  await t.test('a server without TOKEN_ENCRYPTION_KEY refuses to store a secret', async () => {
    const r = await settings('PUT', { clientSecret: SECRET }, bossNoKey, noKey.base);
    assert.equal(r.status, 400);
    assert.match(r.json.error, /TOKEN_ENCRYPTION_KEY/);
    assert.equal((await settings('PUT', { publicUrl: 'https://x.example.com' }, bossNoKey, noKey.base)).status, 200); // non-secret values are fine
  });

  await t.test('check asks GitHub about the saved Client ID', async () => {
    assert.deepEqual((await settings('POST', {}, boss, app.base, '/check')).json.ok, true);
    githubAnswer = { error: 'incorrect_client_credentials' };
    const bad = (await settings('POST', {}, boss, app.base, '/check')).json;
    assert.equal(bad.ok, false);
    assert.match(bad.message, /does not recognise/);
    githubAnswer = { error: 'device_flow_disabled' };
    assert.equal((await settings('POST', {}, boss, app.base, '/check')).json.ok, true); // fine when the Authorize page is used
    await settings('PUT', { clientId: '' });
    assert.match((await settings('POST', {}, boss, app.base, '/check')).json.message, /No Client ID/);
  });
});

test('environment values are the default and saved ones win', { skip: !DB_URL && 'DATABASE_URL not set' }, async (t) => {
  const name = `ccstudio_test_env_${process.pid}`;
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DB_URL);
  url.pathname = `/${name}`;
  const db = await createDb(url.toString());
  const tokenKey = crypto.randomBytes(32).toString('base64');
  const server = http.createServer(createApp({ runner: {}, db, logger: { error() {} }, github: { tokenKey, clientId: 'EnvClientId000001', publicUrl: 'https://env.example.com' } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await db.close(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); });
  await db.query("INSERT INTO users (username, password_hash, role) VALUES ('boss', $1, 'superadmin')", [await hashPassword('boss-password-1')]);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'boss', password: 'boss-password-1' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = async (method, body) => (await fetch(`${base}/api/admin/settings/github`, { method, headers: { 'content-type': 'application/json', cookie }, body: body && JSON.stringify(body) })).json();

  const first = await api('GET');
  assert.deepEqual([first.clientId, first.sources.clientId, first.sources.publicUrl], ['EnvClientId000001', 'environment', 'environment']);
  assert.equal((await api('PUT', { clientId: 'Ov23liSavedClientId' })).clientId, 'Ov23liSavedClientId');
  assert.equal((await api('GET')).sources.clientId, 'database');
  const reset = await api('PUT', { clientId: '' }); // empty removes the saved value: back to the environment's
  assert.deepEqual([reset.clientId, reset.sources.clientId], ['EnvClientId000001', 'environment']);
});
