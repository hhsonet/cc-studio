'use strict';

const express = require('express');
const { createGuards, csrfGuard, createLimiter, hashPassword, checkPassword, NO_PASSWORD } = require('./auth');

const isId = (v) => /^\d+$/.test(String(v));
const MAX_ROWS = 200;
const ROLES = ['student', 'teacher', 'superadmin'];

/** Escape LIKE wildcards so a search for "50%" means 50%. */
const likePattern = (q) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

/**
 * The super admin's dashboard API under /api/admin: numbers for the overview, user management, and every
 * class on the server. (GitHub app settings live in lib/settings.js.)
 */
function createAdminRouter({ db, logger = console }) {
  const router = express.Router();
  router.use(express.json({ limit: '20kb' }));
  router.use(csrfGuard);
  const { wrap, requireRole } = createGuards(db);
  const superAdmin = requireRole('superadmin');
  const resetLimiter = createLimiter({ max: 30, windowMs: 10 * 60 * 1000 });

  // ---- Overview ----
  router.get('/stats', superAdmin, wrap(async (req, res) => {
    const { rows } = await db.query(`
      SELECT
        (SELECT count(*)::int FROM users) AS users,
        (SELECT count(*)::int FROM users WHERE role = 'student') AS students,
        (SELECT count(*)::int FROM users WHERE role = 'teacher') AS teachers,
        (SELECT count(*)::int FROM users WHERE role = 'superadmin') AS admins,
        (SELECT count(*)::int FROM users WHERE github_id IS NOT NULL) AS "githubAccounts",
        (SELECT count(*)::int FROM users WHERE password_hash = '${NO_PASSWORD}') AS "githubOnly",
        (SELECT count(*)::int FROM users WHERE created_at > now() - interval '7 days') AS "newThisWeek",
        (SELECT count(*)::int FROM classes) AS classes,
        (SELECT count(*)::int FROM class_members) AS memberships,
        (SELECT count(*)::int FROM assignments WHERE kind = 'assignment') AS assignments,
        (SELECT count(*)::int FROM assignments WHERE kind = 'shared') AS shared,
        (SELECT count(*)::int FROM workspaces) AS workspaces,
        (SELECT count(*)::int FROM github_links) AS "githubLinks",
        (SELECT count(*)::int FROM github_links WHERE repo IS NOT NULL) AS "githubRepos",
        (SELECT count(*)::int FROM sessions WHERE expires_at > now()) AS "activeSessions",
        pg_database_size(current_database())::bigint AS "databaseBytes"`);
    const newest = (await db.query('SELECT id, username, email, role, created_at AS "createdAt" FROM users ORDER BY id DESC LIMIT 8')).rows;
    res.set('Cache-Control', 'no-store');
    res.json({ stats: { ...rows[0], databaseBytes: Number(rows[0].databaseBytes) }, newest });
  }));

  // ---- Users ----
  router.get('/users', superAdmin, wrap(async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    const role = ROLES.includes(req.query.role) ? req.query.role : '';
    const params = [q ? likePattern(q) : '', role];
    const where = "($1 = '' OR u.username ILIKE $1 OR u.email ILIKE $1) AND ($2 = '' OR u.role = $2)";
    const { rows } = await db.query(
      `SELECT u.id, u.email, u.username, u.role, u.created_at AS "createdAt",
              (u.github_id IS NOT NULL) AS "githubLinked", (u.password_hash <> '${NO_PASSWORD}') AS "hasPassword",
              w.updated_at AS "workspaceUpdatedAt"
       FROM users u LEFT JOIN workspaces w ON w.user_id = u.id
       WHERE ${where} ORDER BY u.id LIMIT ${MAX_ROWS}`, params);
    const total = (await db.query(`SELECT count(*)::int AS n FROM users u WHERE ${where}`, params)).rows[0].n;
    res.set('Cache-Control', 'no-store');
    res.json({ users: rows, total, limit: MAX_ROWS });
  }));

  // Promote or demote between student and teacher. A super admin's role cannot change here.
  router.put('/users/:id/role', superAdmin, wrap(async (req, res) => {
    const role = req.body && req.body.role;
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad user id.' });
    if (role !== 'student' && role !== 'teacher') return res.status(400).json({ error: 'Role must be student or teacher.' });
    const r = await db.query("UPDATE users SET role = $1 WHERE id = $2 AND role <> 'superadmin' RETURNING id", [role, req.params.id]);
    res.status(r.rowCount ? 200 : 404).json(r.rowCount ? { ok: true } : { error: 'No such user, or that is a super admin.' });
  }));

  // Set a new password for someone who is locked out. They are signed out everywhere.
  router.post('/users/:id/password', superAdmin, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad user id.' });
    if (!resetLimiter.take(`reset:${req.user.id}`)) return res.status(429).json({ error: 'Too many resets. Wait a few minutes.' });
    if (String(req.user.id) === req.params.id) return res.status(400).json({ error: 'Change your own password on your profile page.' });
    const pw = req.body && req.body.newPassword;
    const bad = checkPassword(pw);
    if (bad) return res.status(400).json({ error: bad });
    const target = (await db.query('SELECT role FROM users WHERE id = $1', [req.params.id])).rows[0];
    if (!target) return res.status(404).json({ error: 'No such user.' });
    if (target.role === 'superadmin') return res.status(400).json({ error: 'A super admin password cannot be reset here.' });
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(pw), req.params.id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [req.params.id]);
    res.json({ ok: true });
  }));

  router.delete('/users/:id', superAdmin, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad user id.' });
    if (String(req.user.id) === req.params.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
    const target = (await db.query('SELECT role FROM users WHERE id = $1', [req.params.id])).rows[0];
    if (!target) return res.status(404).json({ error: 'No such user.' });
    if (target.role === 'superadmin') return res.status(400).json({ error: 'A super admin account cannot be deleted here.' });
    await db.query('DELETE FROM users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  }));

  // ---- Classes: every class on the server ----
  router.get('/classes', superAdmin, wrap(async (req, res) => {
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.code, c.created_at AS "createdAt", COALESCE(t.username, t.email) AS teacher,
              (SELECT count(*)::int FROM class_members m WHERE m.class_id = c.id) AS students,
              (SELECT count(*)::int FROM assignments a WHERE a.class_id = c.id) AS items
       FROM classes c JOIN users t ON t.id = c.teacher_id ORDER BY c.id DESC LIMIT ${MAX_ROWS}`);
    res.set('Cache-Control', 'no-store');
    res.json({ classes: rows });
  }));

  router.delete('/classes/:id', superAdmin, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad class id.' });
    const r = await db.query('DELETE FROM classes WHERE id = $1', [req.params.id]);
    res.status(r.rowCount ? 200 : 404).json(r.rowCount ? { ok: true } : { error: 'No such class.' });
  }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    logger.error('Admin route error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  });

  return router;
}

module.exports = { createAdminRouter };
