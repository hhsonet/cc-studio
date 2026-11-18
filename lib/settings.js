'use strict';

const express = require('express');
const { createGuards, csrfGuard } = require('./auth');
const { parseKey, encrypt, decrypt } = require('./crypto');

const CLIENT_ID_RE = /^[A-Za-z0-9._-]{10,60}$/;
const SECRET_RE = /^[\x21-\x7e]{16,200}$/; // printable ASCII, no spaces
const SCOPES = ['public_repo', 'repo'];
const CACHE_MS = 30 * 1000;

/** An https address (or http on localhost), reduced to its origin. '' means "not set"; null means invalid. */
function normalizePublicUrl(value) {
  if (value === '') return '';
  let u;
  try { u = new URL(value); } catch { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) return null;
  if (u.username || u.password) return null;
  return u.origin;
}

/**
 * Settings an admin can change at run time, kept in Postgres (secrets encrypted with TOKEN_ENCRYPTION_KEY).
 * A value saved here wins over the one from the environment, which stays as the default. Changes apply
 * without a restart.
 */
function createSettingsStore({ db, tokenKey, defaults = {} }) {
  const key = parseKey(tokenKey);
  let cache = null;
  let loadedAt = 0;

  async function stored() {
    if (cache && Date.now() - loadedAt < CACHE_MS) return cache;
    const { rows } = await db.query("SELECT key, value, secret FROM app_settings WHERE key LIKE 'github.%'");
    const out = {};
    for (const r of rows) {
      let v = r.value;
      if (r.secret) { try { v = key ? decrypt(key, v) : ''; } catch { v = ''; } } // unreadable (key changed): treated as not set
      out[r.key.slice('github.'.length)] = v;
    }
    cache = out;
    loadedAt = Date.now();
    return out;
  }

  const pick = (saved, name, fallback) => (saved[name] ? saved[name] : fallback || '');

  /** The effective GitHub settings: what is saved, else the environment's value. */
  async function github() {
    const s = await stored();
    return {
      clientId: pick(s, 'client_id', defaults.clientId),
      clientSecret: pick(s, 'client_secret', defaults.clientSecret),
      publicUrl: pick(s, 'public_url', defaults.publicUrl),
      scope: pick(s, 'scope', defaults.scope) || 'public_repo',
    };
  }

  /** For the admin page: never the secret itself, and where each value comes from. */
  async function describeGithub() {
    const s = await stored();
    const eff = await github();
    const source = (name, envValue) => (s[name] ? 'database' : envValue ? 'environment' : 'none');
    return {
      clientId: eff.clientId,
      hasSecret: Boolean(eff.clientSecret),
      publicUrl: eff.publicUrl,
      scope: eff.scope,
      sources: {
        clientId: source('client_id', defaults.clientId),
        clientSecret: source('client_secret', defaults.clientSecret),
        publicUrl: source('public_url', defaults.publicUrl),
        scope: source('scope', defaults.scope),
      },
    };
  }

  /** patch: { clientId, clientSecret, clearSecret, publicUrl, scope }, every field optional. An empty value removes the saved one. */
  async function saveGithub(patch, userId) {
    const ops = [];
    const set = (name, value, secret) => ops.push(value === ''
      ? db.query('DELETE FROM app_settings WHERE key = $1', [`github.${name}`])
      : db.query(
        `INSERT INTO app_settings (key, value, secret, updated_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, secret = EXCLUDED.secret, updated_at = now(), updated_by = EXCLUDED.updated_by`,
        [`github.${name}`, secret ? encrypt(key, value) : value, secret, userId]));
    if (patch.clientId !== undefined) set('client_id', patch.clientId, false);
    if (patch.publicUrl !== undefined) set('public_url', patch.publicUrl, false);
    if (patch.scope !== undefined) set('scope', patch.scope, false);
    if (patch.clearSecret) set('client_secret', '', true);
    else if (patch.clientSecret) set('client_secret', patch.clientSecret, true);
    await Promise.all(ops);
    cache = null;
  }

  return { github, describeGithub, saveGithub, canStoreSecrets: Boolean(key) };
}

/** Super-admin routes under /api/admin/settings. */
function createSettingsRouter({ db, settings, fetchImpl = fetch, logger = console }) {
  const router = express.Router();
  router.use(express.json({ limit: '20kb' }));
  router.use(csrfGuard);
  const { wrap, requireRole } = createGuards(db);
  const superAdmin = requireRole('superadmin');

  const callbackUrl = (req, publicUrl) => `${publicUrl || `${req.protocol}://${req.get('host')}`}/api/github/oauth/callback`;

  const view = async (req) => {
    const d = await settings.describeGithub();
    return { ...d, callbackUrl: callbackUrl(req, d.publicUrl), callbackIsGuess: !d.publicUrl, canStoreSecrets: settings.canStoreSecrets };
  };

  router.get('/github', superAdmin, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(await view(req));
  }));

  router.put('/github', superAdmin, wrap(async (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const patch = {};
    if (b.clientId !== undefined) {
      const v = typeof b.clientId === 'string' ? b.clientId.trim() : null;
      if (v === null || (v !== '' && !CLIENT_ID_RE.test(v))) return res.status(400).json({ error: 'That does not look like a GitHub Client ID (letters and digits, no spaces).' });
      patch.clientId = v;
    }
    if (b.publicUrl !== undefined) {
      const v = typeof b.publicUrl === 'string' ? normalizePublicUrl(b.publicUrl.trim()) : null;
      if (v === null) return res.status(400).json({ error: 'The public address must start with https:// (http:// is only allowed for localhost).' });
      patch.publicUrl = v;
    }
    if (b.scope !== undefined) {
      if (!SCOPES.includes(b.scope)) return res.status(400).json({ error: 'Permission must be public_repo or repo.' });
      patch.scope = b.scope;
    }
    if (b.clearSecret === true) {
      patch.clearSecret = true;
    } else if (b.clientSecret !== undefined && b.clientSecret !== '') {
      if (typeof b.clientSecret !== 'string' || !SECRET_RE.test(b.clientSecret.trim())) return res.status(400).json({ error: 'That does not look like a client secret (at least 16 characters, no spaces).' });
      if (!settings.canStoreSecrets) return res.status(400).json({ error: 'TOKEN_ENCRYPTION_KEY is not set on the server, so a secret cannot be stored safely.' });
      patch.clientSecret = b.clientSecret.trim();
    }
    await settings.saveGithub(patch, req.user.id);
    res.json(await view(req));
  }));

  // Ask GitHub whether it knows the saved Client ID. (This does not check the secret: only a real sign-in can.)
  router.post('/github/check', superAdmin, wrap(async (req, res) => {
    const eff = await settings.github();
    if (!eff.clientId) return res.json({ ok: false, message: 'No Client ID is set yet.' });
    let body = null;
    try {
      const r = await fetchImpl('https://github.com/login/device/code', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'cc-studio' },
        body: JSON.stringify({ client_id: eff.clientId }),
      });
      body = await r.json();
    } catch (err) {
      logger.error('GitHub check failed:', err.message);
      return res.status(502).json({ error: 'Could not reach GitHub.' });
    }
    if (body && body.device_code) return res.json({ ok: true, message: 'GitHub knows this Client ID, and Device Flow is on.' });
    if (body && body.error === 'device_flow_disabled') return res.json({ ok: true, message: 'GitHub knows this Client ID. Device Flow is off for the app, which only matters if you use the typed-code login instead of the Authorize page.' });
    if (body && body.error === 'incorrect_client_credentials') return res.json({ ok: false, message: 'GitHub does not recognise this Client ID.' });
    return res.json({ ok: false, message: `GitHub answered: ${(body && (body.error_description || body.error)) || 'something unexpected'}.` });
  }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    logger.error('Settings route error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  });

  return router;
}

module.exports = { createSettingsStore, createSettingsRouter, normalizePublicUrl };
