'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { ALLOWED_EXT, PATH_RE, MAX_SOURCE_BYTES } = require('./validate');

const COOKIE = 'cc_session';
const SESSION_DAYS = 30;
const MAX_WORKSPACE_FILES = 200;
const MAX_WORKSPACE_BYTES = 2 * 1024 * 1024;

// ---- Passwords: scrypt with a random salt, stored as "scrypt$N$r$p$salt$hash" ----

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const scrypt = (password, salt, o) => new Promise((resolve, reject) =>
  crypto.scrypt(password, salt, o.keylen, { N: o.N, r: o.r, p: o.p }, (err, key) => (err ? reject(err) : resolve(key))));

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  const [alg, N, r, p, salt, hash] = String(stored).split('$');
  if (alg !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(password, Buffer.from(salt, 'base64'), { N: +N, r: +r, p: +p, keylen: expected.length });
  return crypto.timingSafeEqual(key, expected);
}

// ---- Input checks ----

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const normalizeEmail = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

function checkCredentials(body, { strict }) {
  const email = normalizeEmail(body && body.email);
  const password = body && body.password;
  if (!EMAIL_RE.test(email) || email.length > 254) return { error: 'Enter a valid email address.' };
  if (typeof password !== 'string' || password.length === 0) return { error: 'Enter your password.' };
  if (strict && (password.length < 8)) return { error: 'Use a password of at least 8 characters.' };
  if (password.length > 200) return { error: 'That password is too long.' };
  return { email, password };
}

/**
 * Sign-up details besides the credentials: a full name (required) and a student id (optional).
 * Returns { fullName, studentId } (studentId null when left empty) or { error }.
 */
function checkProfile(body) {
  const clean = (v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
  const fullName = clean(body && body.fullName);
  if (fullName.length < 2) return { error: 'Enter your full name.' };
  if (fullName.length > 80 || /[\u0000-\u001f\u007f<>]/.test(fullName)) return { error: 'Use 2 to 80 characters for your name, without < or >.' };
  const studentId = clean(body && body.studentId);
  if (!studentId) return { fullName, studentId: null };
  if (!/^[\p{L}\p{N}._/-]{1,32}$/u.test(studentId)) return { error: 'A student ID can have letters, digits and . _ / - (up to 32 characters).' };
  return { fullName, studentId };
}

/** Login accepts an email or a username. */
function checkLogin(body) {
  const id = normalizeEmail(body && body.email);
  const password = body && body.password;
  if (!id || id.length > 254) return { error: 'Enter your email or username.' };
  if (typeof password !== 'string' || password.length === 0) return { error: 'Enter your password.' };
  if (password.length > 200) return { error: 'That password is too long.' };
  return { id, password };
}

/** New-password rule shared by sign-up, change and reset. Returns an error string or ''. */
const checkPassword = (pw) => (typeof pw !== 'string' || pw.length < 8 ? 'Use a password of at least 8 characters.' : pw.length > 200 ? 'That password is too long.' : '');

/** A GitHub profile picture, built from the numeric account id we already keep (no extra column, no token). Null when not tied to GitHub. */
const avatarFor = (githubId) => (/^\d{1,20}$/.test(String(githubId == null ? '' : githubId)) ? `https://avatars.githubusercontent.com/u/${githubId}?s=96` : null);
const publicUser = (u) => ({ id: u.id, avatarUrl: avatarFor(u.github_id), email: u.email, username: u.username, fullName: u.full_name || u.fullName || null, studentId: u.student_id || u.studentId || null, role: u.role, createdAt: u.created_at || u.createdAt, hasPassword: u.has_password !== false });

/** Validate a workspace document: { files: {path: text}, open?, collapsed? }. Returns the cleaned value or { error }. */
function cleanWorkspace(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'workspace must be an object.' };
  const { files, open, collapsed } = raw;
  if (!files || typeof files !== 'object' || Array.isArray(files)) return { error: 'files must be an object.' };
  const paths = Object.keys(files);
  if (paths.length === 0 || paths.length > MAX_WORKSPACE_FILES) return { error: `A workspace holds 1 to ${MAX_WORKSPACE_FILES} files.` };
  let total = 0;
  for (const p of paths) {
    if (!PATH_RE.test(p) || !ALLOWED_EXT.test(p)) return { error: `Invalid file name "${p.slice(0, 40)}".` };
    if (typeof files[p] !== 'string') return { error: `File "${p}" must be text.` };
    total += Buffer.byteLength(files[p], 'utf8');
    if (Buffer.byteLength(files[p], 'utf8') > MAX_SOURCE_BYTES) return { error: `File "${p}" is larger than 64 KB.` };
  }
  if (total > MAX_WORKSPACE_BYTES) return { error: 'A workspace can hold at most 2 MB in total.' };
  const cleanCollapsed = {};
  if (collapsed && typeof collapsed === 'object' && !Array.isArray(collapsed)) {
    for (const [k, v] of Object.entries(collapsed)) if (v === true && PATH_RE.test(k.replace(/\/$/, ''))) cleanCollapsed[k] = true;
  }
  return { value: { files, open: typeof open === 'string' && files[open] !== undefined ? open : paths.sort()[0], collapsed: cleanCollapsed } };
}

// ---- Small in-memory rate limiter (per key, sliding window) ----

function createLimiter({ max, windowMs }) {
  const hits = new Map();
  return {
    /** true if the key is still allowed; counts this attempt. */
    take(key) {
      const now = Date.now();
      const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
      list.push(now);
      hits.set(key, list);
      if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
      return list.length <= max;
    },
    reset(key) { hits.delete(key); },
  };
}

// ---- Cookies ----

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * CSRF defence on top of SameSite=Lax: a state-changing request that names an Origin must name this site,
 * and anything that carries a body must be JSON.
 */
function csrfGuard(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* bad origin */ }
    if (host !== req.headers.host) return res.status(403).json({ error: 'Cross-site request blocked.' });
  }
  // A DELETE has no body, so only requests that carry one must say they are JSON.
  if (req.method !== 'DELETE' && !req.is('application/json')) return res.status(415).json({ error: 'Send JSON.' });
  return next();
}

const cookieOptions = (req, maxAgeMs) => ({
  httpOnly: true,
  sameSite: 'lax',
  secure: req.secure,
  path: '/',
  maxAge: maxAgeMs,
});

/** The password_hash of an account that signs in with GitHub only: it never matches any password. */
const NO_PASSWORD = 'github-only';

/** Session lookup and route guards shared by the account, class and GitHub routers. */
function createGuards(db) {
  async function loadUser(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.username, u.full_name, u.student_id, u.github_id, u.role, u.created_at, (u.password_hash <> '${NO_PASSWORD}') AS has_password FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [hashToken(token)]
    );
    return rows[0] || null;
  }
  async function startSession(req, res, userId) {
    const token = crypto.randomBytes(32).toString('base64url');
    const maxAge = SESSION_DAYS * 24 * 3600 * 1000;
    await db.query(
      'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + ($3 || \' days\')::interval)',
      [hashToken(token), userId, String(SESSION_DAYS)]
    );
    res.cookie(COOKIE, token, cookieOptions(req, maxAge));
  }
  const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
  const requireUser = wrap(async (req, res, next) => {
    const user = await loadUser(req);
    if (!user) return res.status(401).json({ error: 'Log in first.' });
    req.user = user;
    return next();
  });
  /** requireUser, then only the listed roles may pass. */
  const requireRole = (...roles) => [requireUser, (req, res, next) => (roles.includes(req.user.role) ? next() : res.status(403).json({ error: 'You do not have permission to do that.' }))];
  return { loadUser, wrap, requireUser, requireRole, startSession };
}

/**
 * Account routes under /api: POST signup / login / logout, GET me, GET and PUT workspace.
 * Sessions are random tokens in an httpOnly cookie; only their SHA-256 is stored.
 */
function createAuthRouter({ db, logger = console }) {
  const router = express.Router();
  router.use(express.json({ limit: '3mb' }));

  const authLimiter = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });

  router.use(csrfGuard);

  const { loadUser, wrap, requireUser, startSession } = createGuards(db);

  router.post('/signup', wrap(async (req, res) => {
    if (!authLimiter.take(`signup:${req.ip}`)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    const c = checkCredentials(req.body, { strict: true });
    if (c.error) return res.status(400).json({ error: c.error });
    const p = checkProfile(req.body);
    if (p.error) return res.status(400).json({ error: p.error });
    const hash = await hashPassword(c.password);
    let user;
    try {
      const { rows } = await db.query('INSERT INTO users (email, password_hash, full_name, student_id) VALUES ($1, $2, $3, $4) RETURNING id, email, username, full_name, student_id, role, created_at', [c.email, hash, p.fullName, p.studentId]);
      user = rows[0];
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'That email already has an account.' });
      throw err;
    }
    await startSession(req, res, user.id);
    res.status(201).json({ user: publicUser(user) });
  }));

  router.post('/login', wrap(async (req, res) => {
    if (!authLimiter.take(`login:${req.ip}`)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    const c = checkLogin(req.body);
    if (c.error) return res.status(400).json({ error: c.error });
    const { rows } = await db.query(`SELECT id, email, username, full_name, student_id, github_id, role, created_at, password_hash, (password_hash <> '${NO_PASSWORD}') AS has_password FROM users WHERE lower(email) = $1 OR lower(username) = $1`, [c.id]);
    // Hash even for an unknown email so the response time does not reveal which emails exist.
    const ok = await verifyPassword(c.password, rows[0] ? rows[0].password_hash : DUMMY_HASH);
    if (!rows[0] || !ok) return res.status(401).json({ error: 'Wrong email or password.' });
    authLimiter.reset(`login:${req.ip}`);
    await startSession(req, res, rows[0].id);
    res.json({ user: publicUser(rows[0]) });
  }));

  router.post('/logout', wrap(async (req, res) => {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
    res.clearCookie(COOKIE, cookieOptions(req, undefined));
    res.json({ ok: true });
  }));

  router.get('/me', wrap(async (req, res) => {
    const user = await loadUser(req);
    res.set('Cache-Control', 'no-store');
    res.json({ user: user ? publicUser(user) : null });
  }));

  // Edit your details: full name and student ID. An email can be added when the account has none; once set it is
  // the sign-in identity and cannot be changed here (there is no email verification to protect a change).
  const profileLimiter = createLimiter({ max: 30, windowMs: 60 * 60 * 1000 });
  router.put('/profile', requireUser, wrap(async (req, res) => {
    if (!profileLimiter.take(`profile:${req.user.id}`)) return res.status(429).json({ error: 'Too many changes. Try again later.' });
    const p = checkProfile(req.body);
    if (p.error) return res.status(400).json({ error: p.error });
    const wanted = normalizeEmail(req.body && req.body.email);
    let email = null;
    if (wanted && wanted !== req.user.email) {
      if (req.user.email) return res.status(400).json({ error: 'Your email address cannot be changed here.' });
      if (!EMAIL_RE.test(wanted) || wanted.length > 254) return res.status(400).json({ error: 'Enter a valid email address.' });
      email = wanted;
    }
    try {
      // COALESCE: even if two requests race, an email that is already set is never overwritten.
      const { rows } = await db.query(
        `UPDATE users SET full_name = $2, student_id = $3, email = COALESCE(email, $4) WHERE id = $1
         RETURNING id, email, username, full_name, student_id, github_id, role, created_at, (password_hash <> '${NO_PASSWORD}') AS has_password`,
        [req.user.id, p.fullName, p.studentId, email]);
      res.set('Cache-Control', 'no-store');
      res.json({ user: publicUser(rows[0]) });
    } catch (err) {
      if (err.code === '23505') return res.status(409).json({ error: 'That email already has an account.' });
      throw err;
    }
  }));

  // Change password: needs the current one; every other device is signed out.
  router.post('/password', requireUser, wrap(async (req, res) => {
    if (!authLimiter.take(`password:${req.user.id}`)) return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    const { currentPassword, newPassword } = req.body || {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') return res.status(400).json({ error: 'Enter your current and new password.' });
    if (newPassword.length < 8) return res.status(400).json({ error: 'Use a new password of at least 8 characters.' });
    if (newPassword.length > 200) return res.status(400).json({ error: 'That password is too long.' });
    const { rows } = await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    if (rows[0] && rows[0].password_hash === NO_PASSWORD) return res.status(400).json({ error: 'This account signs in with GitHub and has no password.' });
    if (!rows[0] || !(await verifyPassword(currentPassword, rows[0].password_hash))) return res.status(403).json({ error: 'Your current password is wrong.' });
    const token = parseCookies(req.headers.cookie)[COOKIE];
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(newPassword), req.user.id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [req.user.id, hashToken(token)]);
    res.json({ ok: true });
  }));

  router.get('/workspace', requireUser, wrap(async (req, res) => {
    const { rows } = await db.query('SELECT data, updated_at FROM workspaces WHERE user_id = $1', [req.user.id]);
    res.set('Cache-Control', 'no-store');
    res.json(rows[0] ? { workspace: rows[0].data, updatedAt: rows[0].updated_at } : { workspace: null });
  }));

  router.put('/workspace', requireUser, wrap(async (req, res) => {
    const c = cleanWorkspace(req.body && req.body.workspace);
    if (c.error) return res.status(400).json({ error: c.error });
    const { rows } = await db.query(
      `INSERT INTO workspaces (user_id, data) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now() RETURNING updated_at`,
      [req.user.id, JSON.stringify(c.value)]
    );
    res.json({ ok: true, updatedAt: rows[0].updated_at });
  }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Too much data.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    logger.error('Auth route error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  });

  return router;
}

// A real scrypt hash of a random password, used to equalise timing for unknown emails.
const DUMMY_HASH = `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(SCRYPT.keylen).toString('base64')}`;

module.exports = { avatarFor, checkProfile, createAuthRouter, createGuards, csrfGuard, parseCookies, NO_PASSWORD, hashPassword, verifyPassword, cleanWorkspace, createLimiter, publicUser, checkPassword };
