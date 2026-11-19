'use strict';

require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const express = require('express');
const helmet = require('helmet');
const { createDockerRunner } = require('./lib/runner');
const { attachInteractive } = require('./lib/interactive');
const { createDb } = require('./lib/db');
const { createAuthRouter } = require('./lib/auth');
const { createClassesRouter } = require('./lib/classes');
const { createGithubRouter } = require('./lib/github');
const { createSettingsStore, createSettingsRouter } = require('./lib/settings');
const { createAdminRouter } = require('./lib/admin');

/**
 * Rewrite local stylesheet and script URLs in a page to carry a short hash of the file (profile.css -> profile.css?v=1a2b3c4d).
 * A CDN in front (Cloudflare) can keep .css/.js for hours whatever this server says; a changed file now gets a new URL, so
 * visitors never run new HTML with old CSS or JS. The page itself is sent with no-cache, so it is always fresh.
 */
function createAssetVersioner(dir) {
  const cache = new Map();
  const hashOf = (file) => {
    try {
      const { mtimeMs } = fs.statSync(file);
      const hit = cache.get(file);
      if (hit && hit.mtimeMs === mtimeMs) return hit.hash;
      const hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 8);
      cache.set(file, { mtimeMs, hash });
      return hash;
    } catch {
      return null;
    }
  };
  return (html) => html.replace(/\b(href|src)="(\/?[\w.-]+\.(?:css|js))"/g, (whole, attr, ref) => {
    const hash = hashOf(path.join(dir, ref));
    return hash ? `${attr}="${ref}?v=${hash}"` : whole;
  });
}

/**
 * Build the Express app: security headers plus the static page. All code execution
 * goes through the WebSocket endpoint attached in attachInteractive (lib/interactive.js).
 */
function createApp({ runner, db, github = {}, logger = console } = {}) {
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
    // GitHub app settings: saved by an admin (Admin page), with the environment as the default.
    const settings = createSettingsStore({
      db,
      tokenKey: github.tokenKey,
      defaults: { clientId: github.clientId, clientSecret: github.clientSecret, publicUrl: github.publicUrl, scope: github.scope },
    });
    app.use('/api/admin/settings', createSettingsRouter({ db, settings, fetchImpl: github.fetchImpl, logger }));
    app.use('/api/admin', createAdminRouter({ db, logger }));
    app.use('/api/github', createGithubRouter({ db, settings, tokenKey: github.tokenKey, fetchImpl: github.fetchImpl, logger }));
    app.use('/api', createAuthRouter({ db, logger }));
  }

  // The formatter is a 2.5 MB file that never changes: let browsers keep it.
  app.use('/vendor', express.static(path.join(__dirname, 'public', 'vendor'), { maxAge: '7d' }));
  // Clean URLs: /profile instead of /profile.html. Old .html links redirect (query kept). Only plain top-level
  // names are matched, so a crafted path like //evil.com.html can never become an open redirect.
  app.use((req, res, next) => {
    const m = /^\/([A-Za-z0-9_-]+)\.html$/.exec(req.path);
    if ((req.method !== 'GET' && req.method !== 'HEAD') || !m) return next();
    const q = req.originalUrl.indexOf('?');
    res.redirect(301, (m[1] === 'index' ? '/' : `/${m[1]}`) + (q === -1 ? '' : req.originalUrl.slice(q)));
  });
  const publicDir = path.join(__dirname, 'public');
  const versioned = createAssetVersioner(publicDir);
  app.get(['/', '/:page'], (req, res, next) => {
    const name = req.path === '/' ? 'index' : req.params.page;
    if (!/^[A-Za-z0-9_-]+$/.test(name)) return next();
    fs.readFile(path.join(publicDir, `${name}.html`), 'utf8', (err, html) => {
      if (err) return next();
      res.set('Cache-Control', 'no-cache').type('html').send(versioned(html));
    });
  });
  app.use(express.static(publicDir, { extensions: ['html'] }));

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
  if (process.env.GITHUB_CLIENT_ID && !process.env.TOKEN_ENCRYPTION_KEY) console.warn('GITHUB_CLIENT_ID is set but TOKEN_ENCRYPTION_KEY is not: GitHub export stays off.');
  console.log(db ? 'Accounts enabled (Postgres connected)' : 'DATABASE_URL not set: accounts and cloud save are disabled');
  const runner = createDockerRunner({ image: process.env.RUNNER_IMAGE || 'gcc:13', limits });
  const server = http.createServer(createApp({
    runner,
    db,
    // Export to GitHub needs an OAuth App's Client ID (device flow on) and a 32-byte key for the stored tokens.
    github: {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET, // with this, GitHub sign-in uses the normal Authorize page instead of a typed code
      publicUrl: process.env.PUBLIC_URL, // e.g. https://cc.example.com: where GitHub sends users back to
      scope: process.env.GITHUB_SCOPE || 'public_repo',
      tokenKey: process.env.TOKEN_ENCRYPTION_KEY,
    },
  }));
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
