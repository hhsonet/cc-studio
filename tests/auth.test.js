'use strict';

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Client } = require('pg');
const { createDb } = require('../lib/db');
const { createApp } = require('../server');
const { hashPassword, verifyPassword, cleanWorkspace, createLimiter } = require('../lib/auth');

test('passwords hash with a random salt and verify', async () => {
  const a = await hashPassword('correct horse');
  const b = await hashPassword('correct horse');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('correct horse', a), true);
  assert.equal(await verifyPassword('wrong', a), false);
  assert.equal(await verifyPassword('x', 'garbage'), false);
});

test('cleanWorkspace accepts good files and rejects bad ones', () => {
  assert.ok(cleanWorkspace({ files: { 'src/main.c': 'int main(){}' }, open: 'src/main.c' }).value);
  assert.ok(cleanWorkspace({ files: { 'a.c': '' }, open: 'missing.c' }).value.open === 'a.c');
  for (const bad of [null, [], { files: {} }, { files: { '../x.c': 'a' } }, { files: { 'x.exe': 'a' } }, { files: { 'x.c': 5 } },
    { files: { 'x.c': 'a'.repeat(70 * 1024) } }]) {
    assert.ok(cleanWorkspace(bad).error, JSON.stringify(bad).slice(0, 60));
  }
});

test('Markdown files are accepted everywhere files are', () => {
  assert.ok(cleanWorkspace({ files: { 'README.md': '# Title', 'src/main.c': 'int main(){}' } }).value);
  const { validateRunBody } = require('../lib/validate');
  assert.equal(validateRunBody({ language: 'c', files: [{ path: 'main.c', content: 'int main(){}' }, { path: 'docs/NOTES.md', content: '# n' }] }).ok, true);
  assert.equal(validateRunBody({ language: 'c', files: [{ path: 'main.c', content: 'x' }, { path: 'a.mdx', content: 'y' }] }).ok, false);
});

test('rate limiter blocks after max attempts', () => {
  const l = createLimiter({ max: 2, windowMs: 1000 });
  assert.deepEqual([l.take('a'), l.take('a'), l.take('a'), l.take('b')], [true, true, false, true]);
});

const DB_URL = process.env.DATABASE_URL;
test('accounts API against Postgres', { skip: !DB_URL && 'DATABASE_URL not set' }, async (t) => {
  // Use a throwaway database so tests never touch real accounts.
  const name = `ccstudio_test_${process.pid}`;
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const testUrl = new URL(DB_URL);
  testUrl.pathname = `/${name}`;
  const db = await createDb(testUrl.toString());
  const server = http.createServer(createApp({ runner: {}, db, logger: { error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.close();
    await db.close();
    await admin.query(`DROP DATABASE ${name}`);
    await admin.end();
  });

  const call = async (method, path, body, cookie) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie && { cookie }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0], raw: res.headers.get('set-cookie') || '' };
  };

  await t.test('signup validates input', async () => {
    assert.equal((await call('POST', '/api/signup', { email: 'nope', password: 'longenough' })).status, 400);
    assert.equal((await call('POST', '/api/signup', { email: 'a@b.co', password: 'short' })).status, 400);
  });

  let cookie;
  await t.test('signup then me', async () => {
    const r = await call('POST', '/api/signup', { email: 'Ada@Example.com', password: 'analytical-engine' });
    assert.equal(r.status, 201);
    assert.equal(r.json.user.email, 'ada@example.com');
    assert.match(r.raw, /HttpOnly/i);
    assert.match(r.raw, /SameSite=Lax/i);
    cookie = r.cookie;
    assert.equal((await call('GET', '/api/me', undefined, cookie)).json.user.email, 'ada@example.com');
    assert.equal((await call('GET', '/api/me')).json.user, null);
  });

  await t.test('duplicate email (any case) is rejected', async () => {
    assert.equal((await call('POST', '/api/signup', { email: 'ADA@example.com', password: 'another-password' })).status, 409);
  });

  await t.test('login: wrong password fails, right password works', async () => {
    assert.equal((await call('POST', '/api/login', { email: 'ada@example.com', password: 'nope-nope' })).status, 401);
    assert.equal((await call('POST', '/api/login', { email: 'ghost@example.com', password: 'nope-nope' })).status, 401);
    const ok = await call('POST', '/api/login', { email: 'ada@example.com', password: 'analytical-engine' });
    assert.equal(ok.status, 200);
    assert.ok(ok.cookie.startsWith('cc_session='));
  });

  await t.test('workspace needs login, saves and loads', async () => {
    assert.equal((await call('GET', '/api/workspace')).status, 401);
    assert.equal((await call('PUT', '/api/workspace', { workspace: { files: { 'a.c': 'x' } } })).status, 401);
    assert.equal((await call('GET', '/api/workspace', undefined, cookie)).json.workspace, null);
    const ws = { files: { 'src/main.c': 'int main(void){return 0;}', 'src/util.h': '#pragma once' }, open: 'src/main.c', collapsed: {} };
    assert.equal((await call('PUT', '/api/workspace', { workspace: ws }, cookie)).status, 200);
    assert.deepEqual((await call('GET', '/api/workspace', undefined, cookie)).json.workspace, ws);
    assert.equal((await call('PUT', '/api/workspace', { workspace: { files: { '../evil.c': 'x' } } }, cookie)).status, 400);
  });

  await t.test('workspaces are private per user', async () => {
    const other = await call('POST', '/api/signup', { email: 'bob@example.com', password: 'bob-password-1' });
    assert.equal((await call('GET', '/api/workspace', undefined, other.cookie)).json.workspace, null);
  });

  await t.test('cross-site writes and non-JSON are blocked', async () => {
    const res = await fetch(`${base}/api/logout`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' } });
    assert.equal(res.status, 403);
    const res2 = await fetch(`${base}/api/logout`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(res2.status, 415);
  });

  await t.test('change password', async () => {
    const login = await call('POST', '/api/login', { email: 'ada@example.com', password: 'analytical-engine' });
    const other = await call('POST', '/api/login', { email: 'ada@example.com', password: 'analytical-engine' });
    const me = await call('GET', '/api/me', undefined, login.cookie);
    assert.ok(me.json.user.id && me.json.user.createdAt);
    assert.equal((await call('POST', '/api/password', { currentPassword: 'analytical-engine', newPassword: 'new-password-1' })).status, 401);
    assert.equal((await call('POST', '/api/password', { currentPassword: 'wrong-wrong', newPassword: 'new-password-1' }, login.cookie)).status, 403);
    assert.equal((await call('POST', '/api/password', { currentPassword: 'analytical-engine', newPassword: 'short' }, login.cookie)).status, 400);
    assert.equal((await call('POST', '/api/password', { currentPassword: 'analytical-engine', newPassword: 'new-password-1' }, login.cookie)).status, 200);
    assert.equal((await call('GET', '/api/me', undefined, login.cookie)).json.user.email, 'ada@example.com'); // this device stays signed in
    assert.equal((await call('GET', '/api/me', undefined, other.cookie)).json.user, null); // other devices are signed out
    assert.equal((await call('POST', '/api/login', { email: 'ada@example.com', password: 'analytical-engine' })).status, 401);
    assert.equal((await call('POST', '/api/login', { email: 'ada@example.com', password: 'new-password-1' })).status, 200);
  });

  await t.test('logout ends the session', async () => {
    assert.equal((await call('POST', '/api/logout', {}, cookie)).status, 200);
    assert.equal((await call('GET', '/api/me', undefined, cookie)).json.user, null);
  });
});
