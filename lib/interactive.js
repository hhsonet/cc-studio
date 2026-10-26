'use strict';

// WebSocket endpoint /ws/run: a live console for one program at a time per connection.
//
// Client -> server (JSON):
//   { type: 'run', language, files: [{path, content}], entry }   start (replaces any running program). `entry` is the
//                                            open file: only the sources in its folder are compiled;
//                                            { language, source_code } is shorthand for one main file
//   { type: 'input', data }                  text for the program's stdin
//   { type: 'eof' }                          close stdin (Ctrl+D)
//   { type: 'kill' }                         stop the program (Ctrl+C / Stop button)
// Server -> client (JSON):
//   { type: 'compile', text, ok }            compiler output: ok=false errors (run did not start), ok=true warnings
//   { type: 'started' }                      program is running
//   { type: 'out', stream, data }            stdout / stderr text
//   { type: 'exit', code, signal, reason, ms }
//   { type: 'error', code, message }         code: invalid | rate_limited | busy | unavailable | internal

const { WebSocketServer } = require('ws');
const { validateRunBody } = require('./validate');

const MAX_INPUT_CHUNK = 4096; // bytes per input message
const MAX_INPUT_TOTAL = 64 * 1024; // bytes of stdin per run

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Client IP for rate limiting. X-Forwarded-For is only believed when the TCP peer
 * is loopback (i.e. Caddy on the same host), mirroring the HTTP `trust proxy` setting.
 */
function clientIp(req, trustLoopbackProxy) {
  const peer = req.socket.remoteAddress || '';
  const xff = req.headers['x-forwarded-for'];
  if (trustLoopbackProxy && LOOPBACK.has(peer) && xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return peer;
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl, tests) send no Origin
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function attachInteractive(server, {
  runner,
  logger = console,
  trustLoopbackProxy = true,
  maxSessions = 200, // programs alive at once (most are just waiting for input: ~15 MB each)
  runsPerMinute = 60, // per IP; generous because a classroom or office can share one IP
  maxConnsPerIp = 30,
} = {}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 80 * 1024 });
  const connsByIp = new Map();
  const runTimes = new Map(); // ip -> timestamps of recent runs
  let activeSessions = 0;

  function allowRun(ip) {
    const now = Date.now();
    const recent = (runTimes.get(ip) || []).filter((t) => now - t < 60000);
    if (recent.length >= runsPerMinute) {
      runTimes.set(ip, recent);
      return false;
    }
    recent.push(now);
    runTimes.set(ip, recent);
    return true;
  }

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname !== '/ws/run') return; // leave other upgrades to whoever else listens
    const reject = (line) => {
      socket.write(`HTTP/1.1 ${line}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!sameOrigin(req)) return reject('403 Forbidden');
    const ip = clientIp(req, trustLoopbackProxy);
    if ((connsByIp.get(ip) || 0) >= maxConnsPerIp) return reject('429 Too Many Requests');
    wss.handleUpgrade(req, socket, head, (ws) => {
      connsByIp.set(ip, (connsByIp.get(ip) || 0) + 1);
      ws.on('close', () => {
        const n = (connsByIp.get(ip) || 1) - 1;
        if (n) connsByIp.set(ip, n); else connsByIp.delete(ip);
      });
      handleConnection(ws, ip);
    });
  });

  function handleConnection(ws, ip) {
    let session = null; // runner handle for the current program
    let current = null; // token identifying the current run; messages from older runs are dropped
    let inputBytes = 0;

    const send = (obj) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
    };
    const fail = (code, message) => send({ type: 'error', code, message });

    // drop=true: a new run replaces this one, so its exit message must not reach the client.
    function stopSession(drop = false) {
      if (session) session.kill('killed');
      if (drop) { session = null; current = null; }
    }

    async function onRun(msg) {
      stopSession(true);
      const checked = validateRunBody({ language: msg.language, files: msg.files, source_code: msg.source_code, entry: msg.entry });
      if (!checked.ok) return fail('invalid', checked.error);
      if (!allowRun(ip)) return fail('rate_limited', 'Too many runs. Please wait a minute.');
      if (activeSessions >= maxSessions) return fail('busy', 'The server is busy. Please try again in a moment.');
      if (!(await runner.available())) return fail('unavailable', 'Interactive mode is not available on this server.');
      if (ws.readyState !== ws.OPEN) return;

      activeSessions += 1;
      inputBytes = 0;
      let released = false;
      const release = () => {
        if (!released) { released = true; activeSessions -= 1; }
      };
      const token = {};
      current = token;
      const live = () => current === token;
      session = runner.start(checked.value, {
        onCompile: (text, ok) => live() && send({ type: 'compile', text, ok: Boolean(ok) }),
        onStarted: () => live() && send({ type: 'started' }),
        onOutput: (data, stream) => live() && send({ type: 'out', stream, data }),
        onExit: (info) => { release(); if (live()) { session = null; send({ type: 'exit', ...info }); } },
        onError: (message) => { release(); if (live()) { session = null; fail('internal', message); } },
      });
    }

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return fail('invalid', 'Malformed message.');
      }
      if (!msg || typeof msg !== 'object') return fail('invalid', 'Malformed message.');

      switch (msg.type) {
        case 'run':
          onRun(msg).catch((err) => { logger.error('run failed:', err); fail('internal', 'Internal error.'); });
          break;
        case 'input': {
          if (!session || typeof msg.data !== 'string') break;
          const size = Buffer.byteLength(msg.data, 'utf8');
          if (size > MAX_INPUT_CHUNK || inputBytes + size > MAX_INPUT_TOTAL) return fail('invalid', 'Input too large.');
          inputBytes += size;
          session.write(msg.data);
          break;
        }
        case 'eof':
          if (session) session.endInput();
          break;
        case 'kill':
          stopSession();
          break;
        default:
          fail('invalid', 'Unknown message type.');
      }
    });

    // Closing the tab must never leave a program running.
    ws.on('close', () => stopSession(true));
    ws.on('error', (err) => { logger.error('ws error:', err.message); stopSession(true); });
  }

  return { wss, close: () => wss.close() };
}

module.exports = { attachInteractive, clientIp };
