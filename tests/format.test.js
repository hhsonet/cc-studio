'use strict';

// Tests for the Format button's engine (clang-format compiled to WebAssembly, vendored in
// public/vendor/clang-format) and for how the server delivers it. The wasm file is the same one the
// browser loads; here it is initialised synchronously from disk.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createApp } = require('../server');
const { formatConfig, STYLES } = require('../public/format-config.js');

const VENDOR = path.join(__dirname, '..', 'public', 'vendor', 'clang-format');
let cf;
test.before(async () => {
  cf = await import(pathToFileURL(path.join(VENDOR, 'clang-format-web.js')).href);
  cf.initSync(fs.readFileSync(path.join(VENDOR, 'clang-format.wasm')));
});

const cfg = (style = 'LLVM', size = 4) => formatConfig(style, size); // the very config the page uses
const MESSY = '#include <stdio.h>\nint main(void){int x=1;if(x>0){printf("%d\\n",x);}else{return 1;}\nfor(int i=0;i<3;i++)x+=i;\nreturn 0;}\n';

test('formats messy C: spacing, braces and indentation', () => {
  const out = cf.format(MESSY, 'main.c', cfg());
  assert.equal(out, [
    '#include <stdio.h>',
    'int main(void) {',
    '    int x = 1;',
    '    if (x > 0) {',
    '        printf("%d\\n", x);',
    '    } else {',
    '        return 1;',
    '    }',
    '    for (int i = 0; i < 3; i++)',
    '        x += i;',
    '    return 0;',
    '}',
    '',
  ].join('\n'));
});

test('the indent size setting is honoured (2, 4 and 8) and no tab characters are used', () => {
  for (const size of [2, 4, 8]) {
    const out = cf.format(MESSY, 'main.c', cfg('LLVM', size));
    assert.match(out, new RegExp(`\\n {${size}}int x = 1;`), `size ${size}`);
    assert.doesNotMatch(out, /\t/);
  }
});

test('style presets differ: GNU puts braces on their own line, LLVM does not', () => {
  const llvm = cf.format('int f(int a){return a;}\n', 'a.c', cfg('LLVM'));
  const gnu = cf.format('int f(int a){return a;}\n', 'a.c', cfg('GNU'));
  assert.equal(llvm, 'int f(int a) {\n    return a;\n}\n');
  assert.equal(gnu, 'int\nf (int a)\n{\n    return a;\n}\n');
  assert.deepEqual(STYLES, ['LLVM', 'Google', 'GNU', 'Chromium', 'Mozilla', 'WebKit', 'Microsoft']);
  for (const style of STYLES) {
    const out = cf.format('int main(){if(1)return 0;for(;;)break;return 1;}\n', 'a.c', cfg(style, 4));
    assert.match(out, /main/, style);
    assert.doesNotMatch(out, /\t/, style);
  }
});

test('short functions, ifs and loops are never folded onto one line (the point of the overrides)', () => {
  for (const style of STYLES) {
    const out = cf.format('int main(void) {\n    return 0;\n}\nvoid f(void) {\n    if (1)\n        return;\n    while (0)\n        ;\n}\n', 'a.c', cfg(style));
    assert.doesNotMatch(out, /\{ *return|if \(1\) return|while \(0\) ;/, `${style}:\n${out}`);
    assert.ok(out.split('\n').length >= 9, style);
  }
  // and the config is a plain bounded object: an unknown style name falls back to LLVM
  assert.equal(JSON.parse(formatConfig('Nonsense', 4)).BasedOnStyle, 'LLVM');
  assert.equal(JSON.parse(formatConfig('Google', 8)).IndentWidth, 8);
});

test('formatting is idempotent and leaves neat code alone', () => {
  const once = cf.format(MESSY, 'main.c', cfg());
  assert.equal(cf.format(once, 'main.c', cfg()), once);
});

test('C++ files are understood (templates, namespaces, auto)', () => {
  const out = cf.format('#include <vector>\ntemplate<typename T>T fib(T n){return n<2?n:fib(n-1)+fib(n-2);}\nint main(){std::vector<int>v;for(auto x:v){}return 0;}\n', 'main.cpp', cfg());
  assert.match(out, /template <typename T>\nT fib\(T n\) \{\n {4}return n < 2 \? n : fib\(n - 1\) \+ fib\(n - 2\);\n\}/);
  assert.match(out, /for \(auto x : v\) \{\n {4}\}/);
});

test('comments and string contents are preserved exactly (macro bodies are tidied like any code)', () => {
  const src = '#define MAX(a,b) ((a)>(b)?(a):(b))\n// keep   this   spacing\nconst char*s="a  b   c";/* block */int main(){return 0;}\n';
  const out = cf.format(src, 'a.c', cfg());
  assert.ok(out.includes('#define MAX(a, b) ((a) > (b) ? (a) : (b))'));
  assert.ok(out.includes('// keep   this   spacing'));
  assert.ok(out.includes('"a  b   c"'));
  assert.ok(out.includes('/* block */'));
});

test('broken code is formatted on a best-effort basis and never throws', () => {
  for (const src of ['int main( {', 'int x = ;', '}}}{{{', '#include <', 'void f(){ printf("unterminated); }', '', '\n\n\n']) {
    assert.doesNotThrow(() => cf.format(src, 'a.c', cfg()), JSON.stringify(src));
  }
  assert.equal(cf.format('', 'a.c', cfg()), '');
});

test('an invalid style is reported as an error (the app only ever passes valid presets, and shows errors)', () => {
  assert.throws(() => cf.format('int x=1;\n', 'a.c', 'NotARealStyle'), /clang-format|Invalid/i);
});

// ---- how the server delivers the formatter ----

async function startServer() {
  const server = http.createServer(createApp({ logger: { log() {}, error() {} }, runner: { available: async () => true } }));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

test('server: wasm is served as application/wasm and cached, the JS modules as JavaScript', async () => {
  const srv = await startServer();
  try {
    const wasm = await fetch(`${srv.url}/vendor/clang-format/clang-format.wasm`);
    assert.equal(wasm.status, 200);
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');
    assert.match(wasm.headers.get('cache-control'), /max-age=604800/);
    assert.equal((await wasm.arrayBuffer()).byteLength, fs.statSync(path.join(VENDOR, 'clang-format.wasm')).size);
    const js = await fetch(`${srv.url}/vendor/clang-format/clang-format-web.js`);
    assert.match(js.headers.get('content-type'), /javascript/);
    const app = await fetch(`${srv.url}/app.js`);
    assert.doesNotMatch(app.headers.get('cache-control') || '', /604800/); // only the vendored files are cached for a week
  } finally { await srv.close(); }
});

test('server: the CSP allows WebAssembly but still forbids eval() of strings', async () => {
  const srv = await startServer();
  try {
    const csp = (await fetch(srv.url)).headers.get('content-security-policy');
    const script = /script-src ([^;]*)/.exec(csp)[1];
    assert.match(script, /'wasm-unsafe-eval'/);
    assert.doesNotMatch(script, /'unsafe-eval'/);
    assert.doesNotMatch(script, /'unsafe-inline'/);
  } finally { await srv.close(); }
});
