'use strict';

require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { Client } = require('pg');
const { createDb } = require('../lib/db');
const { createApp } = require('../server');
const { hashPassword } = require('../lib/auth');

const DB_URL = process.env.DATABASE_URL;
test('admin dashboard API', { skip: !DB_URL && 'DATABASE_URL not set' }, async (t) => {
  const name = `ccstudio_test_adm_${process.pid}`;
  const admin = new Client({ connectionString: DB_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(DB_URL);
  url.pathname = `/${name}`;
  const db = await createDb(url.toString());
  const server = http.createServer(createApp({ runner: {}, db, logger: { error() {} } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.close(); await db.close(); await admin.query(`DROP DATABASE ${name}`); await admin.end(); });

  const call = async (method, path, body, cookie) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(cookie && { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, text, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  await db.query("INSERT INTO users (username, password_hash, role) VALUES ('boss', $1, 'superadmin')", [await hashPassword('boss-password-1')]);
  await db.query("INSERT INTO users (username, password_hash, role) VALUES ('boss2', $1, 'superadmin')", [await hashPassword('boss-password-2')]);
  await db.query("INSERT INTO users (username, password_hash, github_id) VALUES ('octocat', 'github-only', 555)");
  const boss = (await call('POST', '/api/login', { email: 'boss', password: 'boss-password-1' })).cookie;
  const ada = await call('POST', '/api/signup', { email: 'ada@example.com', password: 'password-123' });
  const bob = await call('POST', '/api/signup', { email: 'bob_50%@example.com', password: 'password-123' });
  const adaId = ada.json.user.id;
  const bobId = bob.json.user.id;
  await db.query("UPDATE users SET role = 'teacher' WHERE id = $1", [adaId]);
  const adminCall = (method, path, body, cookie = boss) => call(method, `/api/admin${path}`, body, cookie);

  await t.test('every route is for super admins only', async () => {
    for (const [m, p] of [['GET', '/stats'], ['GET', '/users'], ['GET', '/classes'], ['PUT', `/users/${bobId}/role`], ['POST', `/users/${bobId}/password`], ['DELETE', `/users/${bobId}`], ['DELETE', '/classes/1']]) {
      const body = m === 'GET' || m === 'DELETE' ? undefined : {};
      assert.equal((await adminCall(m, p, body, null)).status, 401, `${m} ${p}`);
      assert.equal((await adminCall(m, p, body, bob.cookie)).status, 403, `${m} ${p}`);
    }
  });

  await t.test('overview numbers', async () => {
    const r = await adminCall('GET', '/stats');
    assert.equal(r.status, 200);
    const s = r.json.stats;
    assert.deepEqual([s.users, s.students, s.teachers, s.admins], [5, 2, 1, 2]);
    assert.deepEqual([s.githubAccounts, s.githubOnly, s.newThisWeek], [1, 1, 5]);
    assert.ok(s.activeSessions >= 3 && s.databaseBytes > 0);
    assert.equal(r.json.newest[0].username, null); // newest first: bob, who signed up with an email
    assert.equal(r.json.newest.length, 5);
    assert.ok(!r.text.includes('password_hash'));
  });

  await t.test('user list: search, role filter, how each person signs in', async () => {
    const all = (await adminCall('GET', '/users')).json;
    assert.equal(all.total, 5);
    const octo = all.users.find((u) => u.username === 'octocat');
    assert.deepEqual([octo.githubLinked, octo.hasPassword], [true, false]);
    assert.deepEqual([all.users.find((u) => u.id === adaId).hasPassword, all.users.find((u) => u.id === adaId).githubLinked], [true, false]);
    assert.ok(!JSON.stringify(all).includes('password_hash'));
    assert.deepEqual((await adminCall('GET', '/users?q=ADA')).json.users.map((u) => u.email), ['ada@example.com']); // case-insensitive
    assert.deepEqual((await adminCall('GET', '/users?q=50%25')).json.users.map((u) => u.id), [bobId]); // a literal %, not a wildcard
    assert.equal((await adminCall('GET', '/users?q=%25')).json.total, 1); // "%" alone matches only the name that contains it
    assert.deepEqual((await adminCall('GET', '/users?role=teacher')).json.users.map((u) => u.id), [adaId]);
    assert.equal((await adminCall('GET', '/users?role=bogus')).json.total, 5); // an unknown role is ignored
  });

  await t.test('change a role', async () => {
    assert.equal((await adminCall('PUT', `/users/${bobId}/role`, { role: 'teacher' })).status, 200);
    assert.equal((await adminCall('GET', '/users?role=teacher')).json.total, 2);
    assert.equal((await adminCall('PUT', `/users/${bobId}/role`, { role: 'superadmin' })).status, 400);
    assert.equal((await adminCall('PUT', '/users/abc/role', { role: 'student' })).status, 400);
    const other = (await db.query("SELECT id FROM users WHERE username = 'boss2'")).rows[0].id;
    assert.equal((await adminCall('PUT', `/users/${other}/role`, { role: 'student' })).status, 404); // super admins are left alone
    await adminCall('PUT', `/users/${bobId}/role`, { role: 'student' });
  });

  await t.test('reset a password: signs them out, refuses super admins and yourself', async () => {
    assert.equal((await adminCall('POST', `/users/${adaId}/password`, { newPassword: 'short' })).status, 400);
    assert.equal((await adminCall('POST', '/users/999999/password', { newPassword: 'fresh-password-1' })).status, 404);
    assert.equal((await adminCall('POST', `/users/${adaId}/password`, { newPassword: 'fresh-password-1' })).status, 200);
    assert.equal((await call('GET', '/api/me', undefined, ada.cookie)).json.user, null); // their old session ended
    assert.equal((await call('POST', '/api/login', { email: 'ada@example.com', password: 'password-123' })).status, 401);
    assert.equal((await call('POST', '/api/login', { email: 'ada@example.com', password: 'fresh-password-1' })).status, 200);
    const mine = (await db.query("SELECT id FROM users WHERE username = 'boss'")).rows[0].id;
    const other = (await db.query("SELECT id FROM users WHERE username = 'boss2'")).rows[0].id;
    assert.equal((await adminCall('POST', `/users/${mine}/password`, { newPassword: 'fresh-password-1' })).status, 400);
    assert.equal((await adminCall('POST', `/users/${other}/password`, { newPassword: 'fresh-password-1' })).status, 400);
  });

  await t.test('classes: list everything, delete any class', async () => {
    const adaLogin = (await call('POST', '/api/login', { email: 'ada@example.com', password: 'fresh-password-1' })).cookie;
    const made = await call('POST', '/api/classes', { name: 'CS101' }, adaLogin);
    assert.equal(made.status, 201);
    await call('POST', '/api/classes/join', { code: made.json.class.code }, bob.cookie);
    await call('PUT', '/api/workspace', { workspace: { files: { 'main.c': 'int main(){}' } } }, adaLogin);
    await call('POST', `/api/classes/${made.json.class.id}/assignments`, { title: 'Lab 1', folder: '' }, adaLogin);
    const list = (await adminCall('GET', '/classes')).json.classes;
    assert.equal(list.length, 1);
    assert.deepEqual([list[0].name, list[0].teacher, list[0].students, list[0].items], ['CS101', 'ada@example.com', 1, 1]);
    assert.equal(list[0].code, made.json.class.code); // an admin can see the join code
    assert.equal((await adminCall('GET', '/stats')).json.stats.assignments, 1);
    assert.equal((await adminCall('DELETE', `/classes/${made.json.class.id}`)).status, 200);
    assert.equal((await adminCall('DELETE', `/classes/${made.json.class.id}`)).status, 404);
    assert.equal((await adminCall('GET', '/classes')).json.classes.length, 0);
  });

  await t.test('delete a user: not yourself, not a super admin', async () => {
    const mine = (await db.query("SELECT id FROM users WHERE username = 'boss'")).rows[0].id;
    const other = (await db.query("SELECT id FROM users WHERE username = 'boss2'")).rows[0].id;
    assert.equal((await adminCall('DELETE', `/users/${mine}`)).status, 400);
    assert.equal((await adminCall('DELETE', `/users/${other}`)).status, 400);
    assert.equal((await adminCall('DELETE', `/users/${bobId}`)).status, 200);
    assert.equal((await adminCall('DELETE', `/users/${bobId}`)).status, 404);
    assert.equal((await adminCall('GET', '/users')).json.total, 4);
  });
});
