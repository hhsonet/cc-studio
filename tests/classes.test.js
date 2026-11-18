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
test('classes, teachers and students', { skip: !DB_URL && 'DATABASE_URL not set' }, async (t) => {
  const name = `ccstudio_test_cls_${process.pid}`;
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
    return { status: res.status, json: text ? JSON.parse(text) : null, cookie: (res.headers.get('set-cookie') || '').split(';')[0] };
  };
  const signup = async (email, role) => {
    const r = await call('POST', '/api/signup', { email, password: 'password-123' });
    assert.equal(r.status, 201);
    assert.equal(r.json.user.role, 'student'); // everyone starts as a student
    if (role !== 'student') {
      await db.query('UPDATE users SET role = $1 WHERE id = $2', [role, r.json.user.id]);
    }
    return { cookie: r.cookie, id: r.json.user.id, email };
  };
  const teacher = await signup('teacher@example.com', 'teacher');
  const teacher2 = await signup('teacher2@example.com', 'teacher');
  const stu = await signup('stu@example.com', 'student');
  const stu2 = await signup('stu2@example.com', 'student');

  let klass;
  await t.test('only teachers create classes', async () => {
    assert.equal((await call('POST', '/api/classes', { name: 'CS101' })).status, 401);
    assert.equal((await call('POST', '/api/classes', { name: 'CS101' }, stu.cookie)).status, 403);
    assert.equal((await call('POST', '/api/classes', { name: '  ' }, teacher.cookie)).status, 400);
    const r = await call('POST', '/api/classes', { name: 'CS101' }, teacher.cookie);
    assert.equal(r.status, 201);
    assert.match(r.json.class.code, /^[A-Z2-9]{7}$/);
    klass = r.json.class;
  });

  await t.test('students join with the code; teachers cannot', async () => {
    assert.equal((await call('POST', '/api/classes/join', { code: 'NOPE123' }, stu.cookie)).status, 404);
    assert.equal((await call('POST', '/api/classes/join', { code: klass.code }, teacher2.cookie)).status, 403);
    const j = await call('POST', '/api/classes/join', { code: klass.code.toLowerCase() }, stu.cookie);
    assert.equal(j.status, 200);
    assert.equal((await call('POST', '/api/classes/join', { code: klass.code }, stu.cookie)).status, 200); // joining twice is harmless
    const mine = await call('GET', '/api/classes', undefined, stu.cookie);
    assert.equal(mine.json.role, 'student');
    assert.equal(mine.json.classes.length, 1);
    assert.equal((await call('GET', '/api/classes', undefined, teacher.cookie)).json.classes[0].studentCount, 1);
  });

  await t.test('class detail: teacher sees roster and code, student does not', async () => {
    const tv = await call('GET', `/api/classes/${klass.id}`, undefined, teacher.cookie);
    assert.equal(tv.json.class.isTeacher, true);
    assert.equal(tv.json.class.code, klass.code);
    assert.equal(tv.json.class.students.length, 1);
    const sv = await call('GET', `/api/classes/${klass.id}`, undefined, stu.cookie);
    assert.equal(sv.json.class.isTeacher, false);
    assert.equal(sv.json.class.code, undefined);
    assert.equal(sv.json.class.students, undefined);
    assert.equal((await call('GET', `/api/classes/${klass.id}`, undefined, stu2.cookie)).status, 404); // not a member
    assert.equal((await call('GET', `/api/classes/${klass.id}`, undefined, teacher2.cookie)).status, 404);
  });

  let assignment;
  await t.test('teacher makes an assignment from saved files; student starts it', async () => {
    assert.equal((await call('POST', `/api/classes/${klass.id}/assignments`, { title: 'Lab 1', folder: 'lab1' }, teacher.cookie)).status, 400); // nothing saved yet
    const ws = { files: { 'lab1/main.c': 'int main(void){return 0;}', 'lab1/util.h': '#pragma once', 'other/x.c': 'x' }, open: 'lab1/main.c', collapsed: {} };
    assert.equal((await call('PUT', '/api/workspace', { workspace: ws }, teacher.cookie)).status, 200);
    assert.equal((await call('POST', `/api/classes/${klass.id}/assignments`, { title: 'Lab 1', folder: 'nope' }, teacher.cookie)).status, 400);
    assert.equal((await call('POST', `/api/classes/${klass.id}/assignments`, { title: 'Lab 1', folder: 'lab1' }, stu.cookie)).status, 403);
    const a = await call('POST', `/api/classes/${klass.id}/assignments`, { title: 'Lab 1', folder: 'lab1' }, teacher.cookie);
    assert.equal(a.status, 201);
    assert.equal(a.json.assignment.fileCount, 2);
    assert.equal(a.json.assignment.folder, 'lab-1');
    assignment = a.json.assignment;

    // a student outside the class cannot start it
    assert.equal((await call('POST', `/api/classes/${klass.id}/assignments/${assignment.id}/start`, {}, stu2.cookie)).status, 404);
    const own = { files: { 'mine.c': 'keep me' }, open: 'mine.c', collapsed: {} };
    await call('PUT', '/api/workspace', { workspace: own }, stu.cookie);
    assert.equal((await call('POST', `/api/classes/${klass.id}/assignments/${assignment.id}/start`, {}, stu.cookie)).status, 200);
    const got = (await call('GET', '/api/workspace', undefined, stu.cookie)).json.workspace;
    assert.deepEqual(Object.keys(got.files).sort(), ['lab-1/main.c', 'lab-1/util.h', 'mine.c']);
    assert.equal(got.files['mine.c'], 'keep me');
    assert.equal(got.open, 'lab-1/main.c');
    // starting again would replace their work: needs overwrite
    assert.equal((await call('POST', `/api/classes/${klass.id}/assignments/${assignment.id}/start`, {}, stu.cookie)).status, 409);
    assert.equal((await call('POST', `/api/classes/${klass.id}/assignments/${assignment.id}/start`, { overwrite: true }, stu.cookie)).status, 200);
  });

  await t.test('teacher can read a roster student\'s code, nobody else can', async () => {
    const r = await call('GET', `/api/classes/${klass.id}/students/${stu.id}/workspace`, undefined, teacher.cookie);
    assert.equal(r.status, 200);
    assert.ok(r.json.workspace.files['mine.c']);
    assert.equal((await call('GET', `/api/classes/${klass.id}/students/${stu.id}/workspace`, undefined, teacher2.cookie)).status, 404);
    assert.equal((await call('GET', `/api/classes/${klass.id}/students/${stu.id}/workspace`, undefined, stu.cookie)).status, 403);
    assert.equal((await call('GET', `/api/classes/${klass.id}/students/${stu2.id}/workspace`, undefined, teacher.cookie)).status, 404); // not in the class
    assert.equal((await call('GET', `/api/classes/${klass.id}/students/${teacher2.id}/workspace`, undefined, teacher.cookie)).status, 404);
  });

  await t.test('teacher resets a student password', async () => {
    assert.equal((await call('POST', `/api/classes/${klass.id}/students/${stu.id}/password`, { newPassword: 'short' }, teacher.cookie)).status, 400);
    assert.equal((await call('POST', `/api/classes/${klass.id}/students/${stu.id}/password`, { newPassword: 'fresh-pass-9' }, teacher2.cookie)).status, 404);
    assert.equal((await call('POST', `/api/classes/${klass.id}/students/${stu.id}/password`, { newPassword: 'fresh-pass-9' }, teacher.cookie)).status, 200);
    assert.equal((await call('GET', '/api/me', undefined, stu.cookie)).json.user, null); // old session ended
    assert.equal((await call('POST', '/api/login', { email: 'stu@example.com', password: 'password-123' })).status, 401);
    const ok = await call('POST', '/api/login', { email: 'stu@example.com', password: 'fresh-pass-9' });
    assert.equal(ok.status, 200);
    stu.cookie = ok.cookie;
  });

  await t.test('super admin sets roles; cannot touch a super admin', async () => {
    await db.query("INSERT INTO users (username, password_hash, role) VALUES ('boss', $1, 'superadmin')", [await hashPassword('boss-password-1')]);
    const boss = await call('POST', '/api/login', { email: 'boss', password: 'boss-password-1' });
    assert.equal((await call('PUT', `/api/admin/users/${stu2.id}/role`, { role: 'teacher' }, teacher.cookie)).status, 403);
    assert.equal((await call('PUT', `/api/admin/users/${stu2.id}/role`, { role: 'superadmin' }, boss.cookie)).status, 400);
    assert.equal((await call('PUT', `/api/admin/users/${stu2.id}/role`, { role: 'teacher' }, boss.cookie)).status, 200);
    assert.equal((await call('GET', '/api/classes', undefined, stu2.cookie)).json.role, 'teacher');
    assert.equal((await call('PUT', `/api/admin/users/${boss.json.user.id}/role`, { role: 'student' }, boss.cookie)).status, 404);
  });

  await t.test('removing a student and deleting a class', async () => {
    assert.equal((await call('DELETE', `/api/classes/${klass.id}/students/${stu.id}`, undefined, teacher2.cookie)).status, 404);
    assert.equal((await call('DELETE', `/api/classes/${klass.id}/students/${stu.id}`, undefined, teacher.cookie)).status, 200);
    assert.equal((await call('GET', `/api/classes/${klass.id}`, undefined, stu.cookie)).status, 404);
    await call('POST', '/api/classes/join', { code: klass.code }, stu.cookie);
    assert.equal((await call('DELETE', `/api/classes/${klass.id}/membership`, undefined, stu.cookie)).status, 200);
    assert.equal((await call('DELETE', `/api/classes/${klass.id}`, undefined, teacher2.cookie)).status, 404);
    assert.equal((await call('DELETE', `/api/classes/${klass.id}`, undefined, teacher.cookie)).status, 200);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM assignments')).rows[0].n, 0); // cascade
  });
});
