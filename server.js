'use strict';

require('dotenv').config();

const path = require('node:path');
const http = require('node:http');
const express = require('express');
const helmet = require('helmet');
const { createDockerRunner } = require('./lib/runner');
const { attachInteractive } = require('./lib/interactive');
const { createDb } = require('./lib/db');
const { createAuthRouter } = require('./lib/auth');
const { createClassesRouter } = require('./lib/classes');

/**
 * Build the Express app: security headers plus the static page. All code execution
 * goes through the WebSocket endpoint attached in attachInteractive (lib/interactive.js).
 */
function createApp({ runner, db, logger = console } = {}) {
  const app = express();
  app.locals.runner = runner;
  app.disable('x-powered-by');
  // Behind Caddy on the same host: believe X-Forwarded-For / -Proto from loopback only (needed for the client IP and Secure cookies).
  app.set('trust proxy', process.env.TRUST_PROXY === 'false' ? false : 'loopback');

  // Monaco is loaded from jsDelivr and runs its language workers from blob: URLs,
  // so the CSP has to allow exactly those on top of Helmet's defaults.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          // 'wasm-unsafe-eval' lets the in-browser clang-format (WebAssembly) compile; it does not allow eval() of JS strings.
          scriptSrc: ["'self'", "'wasm-unsafe-eval'", 'https://cdn.jsdelivr.net'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net'],
          fontSrc: ["'self'", 'https://cdn.jsdelivr.net', 'data:'],
          imgSrc: ["'self'", 'data:'],
          workerSrc: ["'self'", 'blob:'],
          // 'self' alone does not reliably cover ws:// in every browser, so name this host's
          // WebSocket origins explicitly (Host is validated so it can't inject CSP tokens).
          connectSrc: ["'self'", (req) => {
            const host = req.headers.host || '';
            return /^[\w.\-:[\]]+$/.test(host) ? `ws://${host} wss://${host}` : "'self'";
          }],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          // Helmet's default would make browsers fetch our CSS/JS over https, which
          // breaks plain-http access (e.g. http://<ip>:3100). Behind Caddy the page is
          // already https, so nothing is lost by turning this off.
          upgradeInsecureRequests: null,
        },
      },
    })
  );

  // Accounts and cloud-saved files. Without a database the app still works, just without login.
  if (db) {
    app.use('/api/classes', createClassesRouter({ db, logger }));
    app.use('/api', createAuthRouter({ db, logger }));
  }

  // The formatter is a 2.5 MB file that never changes: let browsers keep it.
  app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor'), { maxAge: '7d' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error('Unhandled error:', err);
    res.status(500).send('Internal server error.');
  });

  return app;
}

if (require.main === module) {
  main().catch((err) => { console.error('Failed to start:', err); process.exit(1); });
}

async function main() {
  const port = Number(process.env.PORT) || 3000;
  // Positive-number env var, or the default.
  const num = (name, fallback) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback);
  const limits = process.env.MAX_COMPILES ? { maxCompiles: num('MAX_COMPILES', undefined) } : {};
  const db = process.env.DATABASE_URL ? await createDb(process.env.DATABASE_URL) : null;
  console.log(db ? 'Accounts enabled (Postgres connected)' : 'DATABASE_URL not set: accounts and cloud save are disabled');
  const runner = createDockerRunner({ image: process.env.RUNNER_IMAGE || 'gcc:13', limits });
  const server = http.createServer(createApp({ runner, db }));
  attachInteractive(server, {
    runner,
    // Behind Caddy on the same host the real client IP is in X-Forwarded-For; only believe it
    // from loopback, otherwise anyone could dodge the per-IP limits by spoofing it.
    trustLoopbackProxy: process.env.TRUST_PROXY !== 'false',
    ...(process.env.MAX_SESSIONS && { maxSessions: num('MAX_SESSIONS') }),
    ...(process.env.RUNS_PER_MINUTE && { runsPerMinute: num('RUNS_PER_MINUTE') }),
    ...(process.env.CONNS_PER_IP && { maxConnsPerIp: num('CONNS_PER_IP') }),
  });
  runner.available().then((ok) =>
    console.log(ok ? `Runner ready (Docker image ${runner.image})` : `Runner NOT available: cannot use Docker image "${runner.image}"`)
  );
  server.listen(port, () => console.log(`compiler-web listening on port ${port}`));
}

module.exports = { createApp, attachInteractive };
