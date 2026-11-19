'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../server');

async function withApp(fn) {
  const server = http.createServer(createApp({ runner: {}, logger: { log() {}, error() {}, warn() {} } }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}
const get = (base, p) => fetch(base + p, { redirect: 'manual' });

test('pages are served without .html', () => withApp(async (base) => {
  for (const p of ['/', '/profile', '/admin', '/classes']) assert.equal((await get(base, p)).status, 200, p);
}));

test('pages link their CSS and JS with a content hash, and are never cached', () => withApp(async (base) => {
  const r = await get(base, '/profile');
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  const html = await r.text();
  const m = /href="(profile\.css\?v=[0-9a-f]{8})"/.exec(html);
  assert.ok(m, 'profile.css should carry ?v=<hash>');
  assert.match(html, /src="profile\.js\?v=[0-9a-f]{8}"/);
  assert.equal((await get(base, '/' + m[1])).status, 200);
  assert.match(await (await get(base, '/')).text(), /href="style\.css\?v=[0-9a-f]{8}"/);
}));

test('.html URLs redirect to the clean URL and keep the query', () => withApp(async (base) => {
  const r = await get(base, '/profile.html?auth=ok');
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/profile?auth=ok');
  assert.equal((await get(base, '/index.html')).headers.get('location'), '/');
}));

test('a crafted .html path never redirects off-site', () => withApp(async (base) => {
  for (const p of ['//evil.com.html', '/%5Cevil.com.html', '/a/b.html']) {
    const loc = (await get(base, p)).headers.get('location');
    assert.ok(!loc || (loc.startsWith('/') && !loc.startsWith('//') && !loc.includes('\\')), `${p} -> ${loc}`);
  }
}));
