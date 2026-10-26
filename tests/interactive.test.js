'use strict';

// Tests for the console backend: WebSocket protocol (fake runner) and the Docker runner's
// process handling (fake `docker` executable). No real Docker is needed.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createApp, attachInteractive } = require('../server');
const { createDockerRunner, buildDockerArgs, wrapperScript, compileCommand } = require('../lib/runner');
const { validateRunBody, sourcesFor } = require('../lib/validate');

const quiet = { log() {}, error() {} };

// ---------- helpers ----------

async function startServer({ runner, attachOptions = {} }) {
  const app = createApp({ logger: quiet, runner });
  const server = http.createServer(app);
  attachInteractive(server, { runner, logger: quiet, ...attachOptions });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws/run`,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

/** WebSocket client with a message queue: `await c.next(pred)` waits for a matching message. */
function connect(url, options) {
  const ws = new WebSocket(url, options);
  const seen = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString());
    seen.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
  });
  const opened = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  return {
    ws,
    seen,
    opened,
    send: (obj) => ws.send(JSON.stringify(obj)),
    next(pred, ms = 3000) {
      const hit = seen.find(pred);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timed out; saw ${JSON.stringify(seen)}`)), ms);
        waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
      });
    },
    close: () => ws.close(),
  };
}

/** Fake interactive runner: prints a prompt, waits for a line, echoes it, exits. */
function fakeRunner({ available = true } = {}) {
  const calls = { kills: 0, started: 0 };
  return {
    calls,
    available: async () => available,
    start(spec, h) {
      calls.started += 1;
      let done = false;
      const exit = (info) => { if (!done) { done = true; h.onExit(info); } };
      setImmediate(() => {
        if (spec.files.map((f) => f.content).join('\n').includes('BAD')) {
          h.onCompile("main.c:1:1: error: expected ';'");
          return exit({ code: 1, signal: null, reason: 'compile_error', ms: 0 });
        }
        if (spec.files.some((f) => f.content.includes('WARN'))) h.onCompile('main.c:1:1: warning: careful', true);
        h.onStarted();
        h.onOutput('Hello\nEnter: ', 'stdout');
      });
      return {
        write: (data) => { h.onOutput(`You typed ${data}`, 'stdout'); exit({ code: 0, signal: null, reason: null, ms: 5 }); },
        endInput: () => exit({ code: 0, signal: null, reason: null, ms: 5 }),
        kill: () => { calls.kills += 1; exit({ code: 137, signal: 'SIGKILL', reason: 'killed', ms: 5 }); },
      };
    },
  };
}

const goodRun = { type: 'run', language: 'c', source_code: 'int main(){}' };

// ---------- validation ----------

test('validate: accepts a good body and rejects bad ones', () => {
  assert.equal(validateRunBody({ language: 'cpp', source_code: 'int main(){}' }).ok, true);
  const bad = [
    [null, /JSON object/],
    [{ language: 'python', source_code: 'x' }, /"c" or "cpp"/],
    [{ language: 'c', source_code: 42 }, /must be a string/],
    [{ language: 'c', source_code: '   ' }, /must not be empty/],
    [{ language: 'c', source_code: 'a'.repeat(64 * 1024 + 1) }, /64 KB/],
    // 'é' is 2 bytes in UTF-8: 33k of them exceed 64 KB although the string is shorter than 64k.
    [{ language: 'c', source_code: 'é'.repeat(33 * 1024) }, /64 KB/],
  ];
  for (const [body, pattern] of bad) {
    const r = validateRunBody(body);
    assert.equal(r.ok, false);
    assert.match(r.error, pattern);
  }
});

test('validate: multi-file projects', () => {
  const ok = validateRunBody({ language: 'c', files: [
    { path: 'src/main.c', content: 'int main(){}' }, { path: 'src/util.c', content: 'int f(){return 1;}' }, { path: 'src/util.h', content: 'int f(void);' },
  ] });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.files.length, 3);

  const bad = [
    [[{ path: '../evil.c', content: 'x' }], /Invalid file name/],
    [[{ path: '/etc/passwd.c', content: 'x' }], /Invalid file name/],
    [[{ path: 'a//b.c', content: 'x' }], /Invalid file name/],
    [[{ path: "a'; rm -rf /.c", content: 'x' }], /Invalid file name/],
    [[{ path: 'run.sh', content: 'x' }], /Invalid file name/],
    [[{ path: 'a.c', content: 'x' }, { path: 'a.c', content: 'y' }], /Duplicate/],
    [[{ path: 'util.h', content: 'x' }], /No \.c source/],
    [[{ path: 'a.c', content: 'a'.repeat(40000) }, { path: 'b.c', content: 'b'.repeat(40000) }], /64 KB in total/],
    [Array.from({ length: 21 }, (_, i) => ({ path: `f${i}.c`, content: 'x' })), /At most 20/],
    [[{ path: 'a.c' }], /string path and string content/],
  ];
  for (const [files, pattern] of bad) {
    const r = validateRunBody({ language: 'c', files });
    assert.equal(r.ok, false, JSON.stringify(files).slice(0, 80));
    assert.match(r.error, pattern);
  }
  // language decides which sources are compiled: a .c file alone is no C++ project
  assert.equal(validateRunBody({ language: 'cpp', files: [{ path: 'main.c', content: 'int main(){}' }] }).ok, false);
});

test('entry: only the open file\'s folder is built, other folders still ship their headers', () => {
  const files = [
    { path: 'src/main.c', content: 'int main(){}' }, { path: 'src/lib/util.c', content: 'int f(){return 1;}' },
    { path: 'src-2/main.c', content: 'int main(){}' }, { path: 'shared/common.h', content: 'int f(void);' },
  ];
  const r = validateRunBody({ language: 'c', files, entry: 'src-2/main.c' });
  assert.equal(r.ok, true);
  assert.equal(r.value.entry, 'src-2/main.c');
  assert.equal(r.value.files.length, 4); // all files are written so headers can be included from anywhere
  const paths = files.map((f) => f.path);
  assert.deepEqual(sourcesFor('c', paths, 'src/main.c'), ['src/main.c', 'src/lib/util.c']); // subfolders included, src-2/ is not
  assert.deepEqual(sourcesFor('c', paths, 'src-2/main.c'), ['src-2/main.c']);
  assert.equal(sourcesFor('c', paths, undefined).length, 3); // no entry: every source
  assert.match(compileCommand('c', paths, 'src-2/main.c'), /'src-2\/main\.c'.*-lm$/);
  assert.doesNotMatch(compileCommand('c', paths, 'src-2/main.c'), /'src\/main\.c'/);
  assert.match(compileCommand('c', paths, 'src-2/main.c'), /-I\/work -I'\/work\/src-2'/);
  assert.match(compileCommand('c', paths, 'src/main.c'), /'src\/lib\/util\.c' 'src\/main\.c'|'src\/main\.c' 'src\/lib\/util\.c'/);
  // errors
  assert.match(validateRunBody({ language: 'c', files, entry: 'nope.c' }).error, /entry must be/);
  assert.match(validateRunBody({ language: 'c', files, entry: 42 }).error, /entry must be/);
  assert.match(validateRunBody({ language: 'c', files, entry: 'shared/common.h' }).error, /No \.c source file in "shared\/"/);
  assert.match(validateRunBody({ language: 'cpp', files, entry: 'src/main.c' }).error, /No \.cpp source file in "src\/"/);
});

test('compileCommand: compiles every source of the language, not headers or the other language', () => {
  assert.equal(
    compileCommand('c', ['src/util.h', 'src/main.c', 'src/util.c', 'main.cpp']),
    "gcc -std=gnu17 -Wall -O1 -I/work -o /tmp/main 'src/main.c' 'src/util.c' -lm"
  );
  assert.match(compileCommand('cpp', ['a.cpp', 'b.cc', 'c.c']), /g\+\+ .* 'a\.cpp' 'b\.cc'$/);
});

// ---------- docker args ----------

test('docker args: the container is sandboxed and the source is mounted read-only', () => {
  const common = { name: 'n', image: 'gcc:13', dir: '/tmp/x', language: 'c' };
  const args = buildDockerArgs(common);
  const s = args.join(' ');
  assert.match(s, /--network none/);
  assert.match(s, /--cap-drop ALL/);
  assert.match(s, /--security-opt no-new-privileges/);
  assert.match(s, /--read-only/);
  assert.match(s, /--user 65534:65534/);
  assert.match(s, /--memory \d+m/);
  assert.match(s, /--pids-limit \d+/);
  assert.doesNotMatch(s, /privileged/);
  assert.ok(args.includes('-i'));
  assert.ok(args.includes('--init'), 'program must not be PID 1');
  assert.ok(args.includes('/tmp/x:/work:ro'));
  assert.ok(!args.some((a) => a.endsWith(':rw') && a.includes('/tmp/x')), 'source dir must not be writable');
  assert.ok(args.includes('/tmp:rw,exec,size=64m'), 'binary needs an exec tmpfs');
});

test('wrapper script: compiles, announces the result, then execs the program unbuffered', () => {
  const c = wrapperScript({ language: 'c', paths: ['main.c'], cpuSeconds: 10, compileSeconds: 20 });
  assert.match(c, /gcc -std=gnu17/);
  assert.match(c, /exec stdbuf -i0 -o0 -e0 \/tmp\/main/);
  assert.match(c, /ulimit -S -t 10; ulimit -H -t 12/);
  // the CPU limit must be applied after compiling, not before
  assert.ok(c.indexOf('ulimit') > c.indexOf('CRRUN'));
  assert.match(wrapperScript({ language: 'cpp', paths: ['main.cpp'], cpuSeconds: 10, compileSeconds: 20 }), /g\+\+ -std=gnu\+\+17/);
});

// ---------- websocket protocol ----------

test('the page is served with a CSP that has no upgrade-insecure-requests', async () => {
  const srv = await startServer({ runner: fakeRunner() });
  try {
    const res = await fetch(srv.url);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /id="stdin"/);
    assert.doesNotMatch(res.headers.get('content-security-policy'), /upgrade-insecure-requests/);
  } finally { await srv.close(); }
});

test('live run: output appears before input, then input is echoed back, then exit', async () => {
  const srv = await startServer({ runner: fakeRunner() });
  const c = connect(srv.wsUrl);
  try {
    await c.opened;
    c.send(goodRun);
    await c.next((m) => m.type === 'started');
    const first = await c.next((m) => m.type === 'out');
    assert.equal(first.data, 'Hello\nEnter: ');
    assert.ok(!c.seen.some((m) => m.type === 'exit'), 'program must still be waiting for input');

    c.send({ type: 'input', data: '42\n' });
    const echo = await c.next((m) => m.type === 'out' && m.data.startsWith('You typed'));
    assert.equal(echo.data, 'You typed 42\n');
    const exit = await c.next((m) => m.type === 'exit');
    assert.equal(exit.code, 0);
  } finally { c.close(); await srv.close(); }
});

test('live run: compile errors are reported and the program never starts', async () => {
  const srv = await startServer({ runner: fakeRunner() });
  const c = connect(srv.wsUrl);
  try {
    await c.opened;
    c.send({ ...goodRun, source_code: 'BAD' });
    const compile = await c.next((m) => m.type === 'compile');
    assert.match(compile.text, /expected ';'/);
    const exit = await c.next((m) => m.type === 'exit');
    assert.equal(exit.reason, 'compile_error');
    assert.ok(!c.seen.some((m) => m.type === 'started'));
  } finally { c.close(); await srv.close(); }
});

test('live run: a multi-file project and compiler warnings travel over the socket', async () => {
  const srv = await startServer({ runner: fakeRunner() });
  const c = connect(srv.wsUrl);
  try {
    await c.opened;
    c.send({ type: 'run', language: 'c', files: [{ path: 'src/main.c', content: 'WARN' }, { path: 'src/util.c', content: 'x' }] });
    const compile = await c.next((m) => m.type === 'compile');
    assert.deepEqual([compile.ok, compile.text], [true, 'main.c:1:1: warning: careful']);
    await c.next((m) => m.type === 'started');

    c.send({ type: 'run', language: 'c', files: [{ path: '../x.c', content: 'x' }] });
    assert.match((await c.next((m) => m.type === 'error')).message, /Invalid file name/);
  } finally { c.close(); await srv.close(); }
});

test('live run: kill message stops the program', async () => {
  const runner = fakeRunner();
  const srv = await startServer({ runner });
  const c = connect(srv.wsUrl);
  try {
    await c.opened;
    c.send(goodRun);
    await c.next((m) => m.type === 'started');
    c.send({ type: 'kill' });
    const exit = await c.next((m) => m.type === 'exit');
    assert.equal(exit.reason, 'killed');
    assert.equal(runner.calls.kills, 1);
  } finally { c.close(); await srv.close(); }
});

test('live run: closing the socket kills the program', async () => {
  const runner = fakeRunner();
  const srv = await startServer({ runner });
  const c = connect(srv.wsUrl);
  try {
    await c.opened;
    c.send(goodRun);
    await c.next((m) => m.type === 'started');
    c.close();
    for (let i = 0; i < 50 && runner.calls.kills === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(runner.calls.kills, 1);
  } finally { await srv.close(); }
});

test('live run: validation, malformed messages and oversize input are rejected', async () => {
  const srv = await startServer({ runner: fakeRunner() });
  const c = connect(srv.wsUrl);
  try {
    await c.opened;
    c.send({ type: 'run', language: 'rust', source_code: 'x' });
    assert.equal((await c.next((m) => m.type === 'error')).code, 'invalid');

    c.ws.send('not json');
    await c.next((m) => m.type === 'error' && /Malformed/.test(m.message));

    c.send({ type: 'bogus' });
    await c.next((m) => m.type === 'error' && /Unknown/.test(m.message));

    c.send(goodRun);
    await c.next((m) => m.type === 'started');
    c.send({ type: 'input', data: 'x'.repeat(5000) });
    await c.next((m) => m.type === 'error' && /Input too large/.test(m.message));
  } finally { c.close(); await srv.close(); }
});

test('live run: unavailable runner is reported to the client', async () => {
  const srv = await startServer({ runner: fakeRunner({ available: false }) });
  const c = connect(srv.wsUrl);
  try {
    await c.opened;
    c.send(goodRun);
    assert.equal((await c.next((m) => m.type === 'error')).code, 'unavailable');
  } finally { c.close(); await srv.close(); }
});

test('live run: runs per minute are limited per IP', async () => {
  const srv = await startServer({ runner: fakeRunner(), attachOptions: { runsPerMinute: 2 } });
  const c = connect(srv.wsUrl);
  try {
    await c.opened;
    for (let i = 0; i < 2; i++) {
      c.send(goodRun);
      await c.next((m) => m.type === 'started' && c.seen.filter((x) => x.type === 'started').length === i + 1);
    }
    c.send(goodRun);
    assert.equal((await c.next((m) => m.type === 'error')).code, 'rate_limited');
  } finally { c.close(); await srv.close(); }
});

test('live run: concurrent session cap returns busy', async () => {
  const srv = await startServer({ runner: fakeRunner(), attachOptions: { maxSessions: 1 } });
  const a = connect(srv.wsUrl);
  const b = connect(srv.wsUrl);
  try {
    await Promise.all([a.opened, b.opened]);
    a.send(goodRun);
    await a.next((m) => m.type === 'started');
    b.send(goodRun);
    assert.equal((await b.next((m) => m.type === 'error')).code, 'busy');
  } finally { a.close(); b.close(); await srv.close(); }
});

test('websocket: cross-origin upgrade is refused with 403', async () => {
  const srv = await startServer({ runner: fakeRunner() });
  try {
    const status = await new Promise((resolve) => {
      const ws = new WebSocket(srv.wsUrl, { headers: { Origin: 'https://evil.example' } });
      ws.on('unexpected-response', (req, res) => resolve(res.statusCode));
      ws.on('open', () => resolve('opened'));
      ws.on('error', () => {});
    });
    assert.equal(status, 403);

    // Same-origin browsers send Origin matching Host and are allowed.
    const ok = connect(srv.wsUrl, { headers: { Origin: srv.url } });
    await ok.opened;
    ok.close();
  } finally { await srv.close(); }
});

test('CSP allows this host\'s WebSocket origin', async () => {
  const srv = await startServer({ runner: fakeRunner() });
  try {
    const csp = (await fetch(srv.url)).headers.get('content-security-policy');
    assert.match(csp, new RegExp(`connect-src 'self' ws://127\\.0\\.0\\.1:${srv.port} wss://127\\.0\\.0\\.1:${srv.port}`));
  } finally { await srv.close(); }
});

// ---------- docker runner process handling (fake docker executable) ----------

const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fakedocker-'));
const fakeDocker = path.join(stateDir, 'docker');
fs.writeFileSync(fakeDocker, `#!${process.execPath}
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2);
const state = process.env.FAKE_DOCKER_STATE;
const val = (flag) => args[args.indexOf(flag) + 1];
if (args[0] === 'image') process.exit(process.env.FAKE_DOCKER_NO_IMAGE ? 1 : 0);
if (args[0] === 'kill') { fs.writeFileSync(path.join(state, 'killed-' + args[1]), '1'); process.exit(0); }
const dir = val('-v').split(':')[0];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [fs.readFileSync(path.join(d, e.name), 'utf8')]);
const src = walk(dir).join('');
const name = val('--name');
fs.writeFileSync(path.join(state, 'argv-' + name + '.json'), JSON.stringify({ args, files: fs.readdirSync(dir, { recursive: true }) }));
if (src.includes('DOCKER_BROKEN')) { process.stderr.write('permission denied'); process.exit(125); }
function program() {                                 // what runs after the compile marker
  if (src.includes('SEGV')) process.exit(139);
  if (src.includes('LOOP') || src.includes('FLOOD')) {
    const flood = src.includes('FLOOD');
    setInterval(() => {
      if (fs.existsSync(path.join(state, 'killed-' + name))) process.exit(137);
      if (flood) process.stdout.write('x'.repeat(500));
    }, 20);
  } else {
    process.stdout.write('Hello\\nEnter: ');
    process.stdin.once('data', (d) => { process.stdout.write('You typed ' + d.toString()); process.exit(0); });
    process.stdin.once('end', () => process.exit(0));
  }
}
// "Compile", then announce the result on stderr exactly like the real wrapper script does.
setTimeout(() => {
  if (src.includes('COMPILE_ERROR')) { process.stderr.write('\\x01CRCE\\x01main.c:1: error: boom\\n'); process.exit(198); }
  if (src.includes('WARNING')) process.stderr.write('\\x01CRLOG\\x01main.c:1:1: warning: boom\\n');
  process.stderr.write('\\x01CRRUN\\x01');
  program();
}, src.includes('SLOWCOMPILE') ? 400 : 0);
`, { mode: 0o755 });
process.env.FAKE_DOCKER_STATE = stateDir;

/** Run through the real runner with the fake docker; resolves with everything it reported. */
function runWith(runner, source) {
  return new Promise((resolve) => {
    const log = { compile: '', out: '', started: false, exit: null, error: null };
    runner.start({ language: 'c', source_code: source }, {
      onCompile: (t) => { log.compile += t; },
      onStarted: () => { log.started = true; },
      onOutput: (t) => { log.out += t; },
      onExit: (e) => { log.exit = e; resolve(log); },
      onError: (e) => { log.error = e; resolve(log); },
    });
  });
}

const makeRunner = (limits) => createDockerRunner({ dockerBin: fakeDocker, image: 'x', logger: quiet, limits });

test('runner: available() follows whether the image exists', async () => {
  assert.equal(await makeRunner().available(), true);
  process.env.FAKE_DOCKER_NO_IMAGE = '1';
  try { assert.equal(await makeRunner().available(), false); } finally { delete process.env.FAKE_DOCKER_NO_IMAGE; }
});

test('runner: interactive session prints, waits for input, then echoes it', async () => {
  const runner = makeRunner();
  const finished = new Promise((resolve) => {
    const log = { out: '' };
    const session = runner.start({ language: 'c', source_code: 'int main(){}' }, {
      onCompile() {},
      onStarted() {},
      onOutput(t) {
        log.out += t;
        if (log.out.endsWith('Enter: ')) session.write('7\n'); // reply only once the prompt is visible
      },
      onExit: (e) => resolve({ ...log, exit: e }),
      onError: (e) => resolve({ ...log, error: e }),
    });
  });
  const r = await finished;
  assert.equal(r.out, 'Hello\nEnter: You typed 7\n');
  assert.equal(r.exit.code, 0);
  assert.equal(r.exit.reason, null);
});

test('runner: compile errors are returned and the program never runs', async () => {
  const r = await runWith(makeRunner(), 'COMPILE_ERROR');
  assert.match(r.compile, /error: boom/);
  assert.equal(r.exit.reason, 'compile_error');
  assert.equal(r.started, false);
});

test('runner: Docker failures surface as a generic error, not a compile error', async () => {
  const r = await runWith(makeRunner(), 'DOCKER_BROKEN');
  assert.match(r.error, /failed to start/);
  assert.equal(r.compile, '');
});

test('runner: crashes map to signal names', async () => {
  const r = await runWith(makeRunner(), 'SEGV');
  assert.equal(r.exit.code, 139);
  assert.equal(r.exit.signal, 'SIGSEGV');
});

test('runner: kill() stops a running program', async () => {
  const runner = makeRunner();
  const log = await new Promise((resolve) => {
    const session = runner.start({ language: 'c', source_code: 'LOOP' }, {
      onCompile() {}, onOutput() {},
      onStarted: () => setTimeout(() => session.kill('killed'), 100),
      onExit: resolve, onError: resolve,
    });
  });
  assert.equal(log.reason, 'killed');
});

test('runner: compiles queue when maxCompiles is reached, and a queued session can be cancelled', async () => {
  const slow = { language: 'c', source_code: 'SLOWCOMPILE SEGV' }; // compiles slowly, then crashes at once
  const run = (runner) => new Promise((resolve) => runner.start(slow, {
    onCompile() {}, onStarted() {}, onOutput() {}, onExit: resolve, onError: resolve,
  }));
  const elapsed = async (runner, n) => {
    const t0 = Date.now();
    await Promise.all(Array.from({ length: n }, () => run(runner)));
    return Date.now() - t0;
  };
  const serial = await elapsed(makeRunner({ maxCompiles: 1 }), 3);
  const parallel = await elapsed(makeRunner({ maxCompiles: 3 }), 3);
  assert.ok(serial > parallel + 500, `serial ${serial}ms should be well above parallel ${parallel}ms`);

  // Cancelling a queued session frees it without waiting for a compile slot.
  const q = makeRunner({ maxCompiles: 1 });
  const first = run(q);
  const reason = await new Promise((resolve) => {
    const s2 = q.start(slow, { onCompile() {}, onStarted() {}, onOutput() {}, onExit: (e) => resolve(e.reason), onError: resolve });
    setTimeout(() => s2.kill('killed'), 50);
  });
  assert.equal(reason, 'killed');
  await first;
});

test('runner: multi-file project is written to disk and compiled together', async () => {
  const runner = makeRunner();
  const files = [
    { path: 'src/main.c', content: 'int main(){} /* SEGV: makes the fake program crash at once */' },
    { path: 'src/util.c', content: 'int f(){return 1;}' },
    { path: 'src/util.h', content: 'int f(void);' },
  ];
  const before = new Set(fs.readdirSync(stateDir));
  await new Promise((resolve) => runner.start({ language: 'c', files }, {
    onCompile() {}, onStarted() {}, onOutput() {}, onExit: resolve, onError: resolve,
  }));
  // the fake docker records what it was given; find the new record
  const rec = fs.readdirSync(stateDir).filter((f) => f.startsWith('argv-') && !before.has(f))[0];
  assert.ok(rec, 'fake docker should have been started');
  const { args, files: written } = JSON.parse(fs.readFileSync(path.join(stateDir, rec), 'utf8'));
  assert.deepEqual(written.sort(), ['src', 'src/main.c', 'src/util.c', 'src/util.h']);
  const script = args[args.length - 1];
  assert.match(script, /'src\/main\.c' 'src\/util\.c'/);
  assert.doesNotMatch(script, /util\.h/);
});

test('runner: compiler warnings from a successful build are reported with ok=true', async () => {
  const log = { compile: [], out: '' };
  await new Promise((resolve) => {
    const session = makeRunner().start({ language: 'c', source_code: 'WARNING' }, {
      onCompile: (text, ok) => log.compile.push({ text, ok }),
      onStarted() {},
      onOutput(t) { log.out += t; if (log.out.endsWith('Enter: ')) session.write('1\n'); },
      onExit: resolve, onError: resolve,
    });
  });
  assert.deepEqual(log.compile, [{ text: 'main.c:1:1: warning: boom\n', ok: true }]);
  assert.equal(log.out, 'Hello\nEnter: You typed 1\n'); // the log text did not leak into the program output
});

test('runner: idle sessions are killed', async () => {
  const exit = await new Promise((resolve) => {
    makeRunner({ idleMs: 250 }).start({ language: 'c', source_code: 'LOOP' }, {
      onCompile() {}, onStarted() {}, onOutput() {}, onExit: resolve, onError: resolve,
    });
  });
  assert.equal(exit.reason, 'idle');
});

test('runner: runaway output is cut off', async () => {
  const exit = await new Promise((resolve) => {
    makeRunner({ outputBytes: 2000 }).start({ language: 'c', source_code: 'FLOOD' }, {
      onCompile() {}, onStarted() {}, onOutput() {}, onExit: resolve, onError: resolve,
    });
  });
  assert.equal(exit.reason, 'output_limit');
});

test('cleanup: fake docker state dir removed', () => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});
