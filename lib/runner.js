'use strict';

// Interactive runner: compiles and runs one program inside a throwaway Docker container
// and streams its stdin/stdout live. Nothing else is shared between runs.
//
// One container per run (starting a container costs more than compiling, so a single
// container per run roughly doubles throughput compared with separate compile/run ones).
// The container has no network, no capabilities, a read-only root filesystem and a
// non-root user. The source is mounted read-only; gcc writes the binary to a tmpfs.
//
// A small shell wrapper does: compile -> print a marker on stderr -> exec the program.
// The markers tell us which phase we are in:
//   \x01CRCE\x01   compile failed; the rest of stderr is the compiler output
//   \x01CRLOG\x01  compile succeeded with warnings; the text up to CRRUN is the compiler log
//   \x01CRRUN\x01  compile succeeded; everything after this is the program's own output
// stdbuf makes the program's stdout unbuffered, so `printf("Name: ")` appears
// immediately even though stdout is a pipe rather than a terminal.

const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { SOURCE_EXT, sourcesFor, folderOf } = require('./validate');

// -Wall so the editor can show useful warnings (unused variables and the like).
const LANGS = {
  c: { main: 'main.c', cc: 'gcc', flags: '-std=gnu17 -Wall -O1', libs: '-lm', source: SOURCE_EXT.c },
  cpp: { main: 'main.cpp', cc: 'g++', flags: '-std=gnu++17 -Wall -O1', libs: '', source: SOURCE_EXT.cpp },
};

const MARK_CE = '\x01CRCE\x01';
const MARK_LOG = '\x01CRLOG\x01';
const MARK_RUN = '\x01CRRUN\x01';

// Exit codes Docker reports when the process died from a signal (128 + n).
const SIGNALS = { 132: 'SIGILL', 134: 'SIGABRT', 135: 'SIGBUS', 136: 'SIGFPE', 137: 'SIGKILL', 139: 'SIGSEGV', 143: 'SIGTERM', 152: 'SIGXCPU', 153: 'SIGXFSZ' };

const DEFAULT_LIMITS = {
  // Container start + compile is the heavy part (docker + gcc, about a core-second per run).
  // Only this many run at once; the rest wait in line, so a burst of Run clicks slows
  // down instead of overloading the host. Waiting for input does not hold a slot.
  maxCompiles: Math.max(2, os.cpus().length - 1),
  memory: '192m', // whole container: g++ needs ~150 MB while compiling; 200 programs at the cap would be ~38 GB, real ones use ~15 MB
  compileSeconds: 20,
  cpuSeconds: 10, // CPU time the program may burn (ulimit -t); waiting for input is free
  sessionMs: 5 * 60 * 1000, // hard wall-clock cap for one run
  idleMs: 60 * 1000, // kill a running program if nothing is typed or printed for this long
  outputBytes: 1024 * 1024,
};

const shQuote = (x) => `'${x.replace(/'/g, `'\\''`)}'`;

/**
 * The compiler command line (paths are validated, and quoted anyway). With an entry file, only the
 * sources in its folder are compiled, and that folder is added to the include path.
 */
function compileCommand(language, paths, entry) {
  const l = LANGS[language];
  const sources = sourcesFor(language, paths, entry).sort().map(shQuote).join(' ');
  const scope = entry ? folderOf(entry).replace(/\/$/, '') : '';
  const includes = ['-I/work', ...(scope ? [`-I${shQuote(`/work/${scope}`)}`] : [])].join(' ');
  return `${l.cc} ${l.flags} ${includes} -o /tmp/main ${sources} ${l.libs}`.trim();
}

/** The command run inside the container. Exported so tests can inspect it. */
function wrapperScript({ language, paths, entry, cpuSeconds, compileSeconds }) {
  return [
    'cd /work', // compile from here so diagnostics say src/main.c, not a full path
    `timeout -s KILL ${compileSeconds} ${compileCommand(language, paths, entry)} > /tmp/cc.log 2>&1`,
    'rc=$?',
    // tr strips \001 so a source file cannot forge our markers through the compiler log.
    'if [ $rc -ne 0 ]; then',
    '  [ $rc -eq 137 ] && echo "Compilation timed out." > /tmp/cc.log',
    `  printf '\\001CRCE\\001' >&2; tr -d '\\001' < /tmp/cc.log | head -c 65536 >&2; exit 198`,
    'fi',
    `if [ -s /tmp/cc.log ]; then printf '\\001CRLOG\\001' >&2; tr -d '\\001' < /tmp/cc.log | head -c 65536 >&2; fi`,
    `printf '\\001CRRUN\\001' >&2`,
    // No core dumps; a CPU-time cap so `for(;;);` dies. Soft limit < hard limit: the soft
    // one sends SIGXCPU (exit 152, reported as a CPU limit); with equal limits the kernel
    // sends SIGKILL, which looks like an OOM kill. Limits are set only now, so they do not
    // apply to the compiler.
    `ulimit -c 0; ulimit -S -t ${cpuSeconds}; ulimit -H -t ${cpuSeconds + 2}`,
    'cd /tmp', // the program's working directory is the writable tmpfs
    'exec stdbuf -i0 -o0 -e0 /tmp/main',
  ].join('\n');
}

/** docker run arguments for one session. Exported so tests can assert the sandbox. */
function buildDockerArgs({ name, image, dir, language, paths = [LANGS[language].main], entry, memory = DEFAULT_LIMITS.memory, cpuSeconds = DEFAULT_LIMITS.cpuSeconds, compileSeconds = DEFAULT_LIMITS.compileSeconds }) {
  return [
    'run', '-i', '--rm', '--name', name,
    // --init: the program must not be PID 1, or the kernel ignores SIGXCPU/SIGTERM for it.
    '--init',
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--user', '65534:65534',
    '--cpus', '1',
    '--memory', memory, '--memory-swap', memory,
    '--pids-limit', '64',
    '--ulimit', 'nofile=256:256',
    '-e', 'HOME=/tmp',
    '--tmpfs', '/tmp:rw,exec,size=64m', // gcc output and the binary; exec is needed to run it
    '-v', `${dir}:/work:ro`,
    image,
    'sh', '-c', wrapperScript({ language, paths, entry, cpuSeconds, compileSeconds }),
  ];
}

function createDockerRunner({ image = 'gcc:13', dockerBin = 'docker', logger = console, limits = {} } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  let cache = { at: 0, ok: false };

  // Counting semaphore for the startup+compile phase. acquire() resolves true when a slot is
  // held, or false if the waiter was cancelled (its session was killed while queued).
  let compiling = 0;
  const waiting = [];
  function acquireCompile(state) {
    return new Promise((resolve) => {
      if (compiling < lim.maxCompiles) {
        compiling += 1;
        return resolve(true);
      }
      const waiter = () => { compiling += 1; resolve(true); };
      waiting.push(waiter);
      state.cancelWait = () => {
        const i = waiting.indexOf(waiter);
        if (i !== -1) { waiting.splice(i, 1); resolve(false); }
      };
    });
  }
  function releaseCompile() {
    compiling -= 1;
    const next = waiting.shift();
    if (next) next();
  }

  /** True if Docker is reachable by this user and the compiler image is present. */
  async function available() {
    if (Date.now() - cache.at < 30000) return cache.ok;
    const ok = await new Promise((resolve) => {
      const p = spawn(dockerBin, ['image', 'inspect', image], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    });
    if (!ok && cache.ok !== false) logger.error(`Runner unavailable: cannot use Docker image "${image}"`);
    cache = { at: Date.now(), ok };
    return ok;
  }

  function dockerKill(name) {
    const p = spawn(dockerBin, ['kill', name], { stdio: 'ignore' });
    p.on('error', () => {});
  }

  /**
   * Start a run. spec: { language, files: [{path, content}] }. Handlers: onCompile(text, ok), onStarted(), onOutput(text, stream),
   * onExit({code, signal, reason, ms}), onError(message).
   * Returns { write(data), endInput(), kill() }.
   */
  function start(spec, h) {
    const { language } = spec;
    // Normally a list of project files; a bare source_code string means a single main file.
    const files = spec.files || [{ path: LANGS[language].main, content: spec.source_code }];
    const name = `cr-${crypto.randomBytes(6).toString('hex')}`;
    const state = { killed: false, reason: null, child: null, running: false, done: false, cancelWait: null };
    const timers = [];
    let dir = null;
    let slotHeld = false;
    const releaseSlot = () => {
      if (slotHeld) { slotHeld = false; releaseCompile(); }
    };

    const kill = (reason = 'killed') => {
      if (state.done || state.killed) return;
      state.killed = true;
      state.reason = reason;
      if (state.cancelWait) state.cancelWait(); // leave the compile queue immediately
      // `docker kill` fails if the container is not created yet, so retry a few times.
      for (const delay of [0, 500, 2000]) {
        setTimeout(() => {
          if (!state.done) dockerKill(name);
        }, delay);
      }
    };

    const finish = (info) => {
      if (state.done) return;
      state.done = true;
      timers.forEach(clearTimeout);
      releaseSlot();
      if (dir) fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      if (info.error) h.onError(info.error);
      else h.onExit(info);
    };

    let idleTimer = null;
    const touch = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => kill('idle'), lim.idleMs);
      timers[1] = idleTimer;
    };
    timers[0] = setTimeout(() => kill('timeout'), lim.sessionMs);

    (async () => {
      try {
        dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cr-'));
        await fs.chmod(dir, 0o755); // the container's non-root user must be able to read the source
        for (const f of files) {
          const full = path.resolve(dir, f.path);
          if (!full.startsWith(dir + path.sep)) throw new Error(`path escapes work dir: ${f.path}`); // validate.js already forbids this
          await fs.mkdir(path.dirname(full), { recursive: true, mode: 0o755 });
          await fs.writeFile(full, f.content);
        }

        if (!(await acquireCompile(state))) return finish({ code: null, signal: null, reason: state.reason, ms: 0 });
        slotHeld = true;
        if (state.killed) return finish({ code: null, signal: null, reason: state.reason, ms: 0 });

        const child = spawn(dockerBin, buildDockerArgs({ name, image, dir, language, paths: files.map((f) => f.path), entry: spec.entry, ...lim }), { stdio: ['pipe', 'pipe', 'pipe'] });
        state.child = child;
        child.stdin.on('error', () => {}); // EPIPE when the program exits first

        let phase = 'compiling'; // -> 'running' | 'compile_failed'
        let t0 = 0;
        let preStderr = ''; // stderr seen before a marker arrives
        let compileText = '';
        let heldStdout = []; // stdout can outrun the marker; hold it until we know the program started
        let sent = 0;
        const decoders = { stdout: new StringDecoder('utf8'), stderr: new StringDecoder('utf8') };

        const emit = (text, stream) => {
          if (!text) return;
          touch();
          sent += Buffer.byteLength(text);
          if (sent > lim.outputBytes) return kill('output_limit');
          h.onOutput(text, stream);
        };
        const programStarted = () => {
          phase = 'running';
          state.running = true;
          t0 = Date.now();
          releaseSlot(); // compiled: this session no longer counts against the compile limit
          touch(); // idle clock starts when the program does
          h.onStarted();
          for (const chunk of heldStdout) emit(decoders.stdout.write(chunk), 'stdout');
          heldStdout = [];
        };

        child.stdout.on('data', (chunk) => {
          if (phase === 'running') emit(decoders.stdout.write(chunk), 'stdout');
          else heldStdout.push(chunk);
        });
        child.stderr.on('data', (chunk) => {
          if (phase === 'running') return emit(decoders.stderr.write(chunk), 'stderr');
          if (phase === 'compile_failed') { compileText += chunk.toString('utf8'); return; }
          preStderr += chunk.toString('utf8');
          let i = preStderr.indexOf(MARK_RUN);
          if (i !== -1) {
            // Warnings from a successful compile arrive between CRLOG and CRRUN.
            const before = preStderr.slice(0, i);
            const j = before.indexOf(MARK_LOG);
            if (j !== -1) h.onCompile(before.slice(j + MARK_LOG.length), true);
            const rest = preStderr.slice(i + MARK_RUN.length);
            preStderr = '';
            programStarted();
            emit(rest, 'stderr');
            return;
          }
          i = preStderr.indexOf(MARK_CE);
          if (i !== -1) {
            phase = 'compile_failed';
            compileText = preStderr.slice(i + MARK_CE.length);
            preStderr = '';
          }
        });
        child.on('error', (err) => {
          logger.error('Docker run failed to spawn:', err.message);
          finish({ error: 'The code runner failed to start.' });
        });
        child.on('close', (code) => {
          if (phase === 'compile_failed') {
            h.onCompile(compileText, false);
            return finish({ code, signal: null, reason: 'compile_error', ms: 0 });
          }
          if (phase === 'compiling') {
            // The container never reached either marker. If we killed it, that's the reason;
            // otherwise Docker itself (or the image) failed, which is not a user error.
            if (state.killed) return finish({ code: null, signal: null, reason: state.reason, ms: 0 });
            logger.error(`Docker run failed before compiling (exit ${code}): ${preStderr.slice(0, 300)}`);
            return finish({ error: 'The code runner failed to start.' });
          }
          let reason = state.reason;
          if (!reason && code === 152) reason = 'cpu_limit';
          if (!reason && code === 137) reason = 'memory_limit'; // SIGKILL we did not send: almost always the OOM killer
          finish({ code, signal: SIGNALS[code] || null, reason, ms: Date.now() - t0 });
        });
      } catch (err) {
        logger.error('Runner error:', err);
        finish({ error: 'The code runner failed to start.' });
      }
    })();

    return {
      write(data) {
        const stdin = state.running && state.child ? state.child.stdin : null;
        if (stdin && !stdin.destroyed && !stdin.writableEnded) {
          touch();
          stdin.write(data);
        }
      },
      endInput() {
        const c = state.child;
        if (state.running && c && !c.stdin.writableEnded) c.stdin.end();
      },
      kill,
    };
  }

  return { available, start, image };
}

module.exports = { createDockerRunner, buildDockerArgs, wrapperScript, compileCommand, SIGNALS, DEFAULT_LIMITS };
