'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { createGuards, csrfGuard, createLimiter, cleanWorkspace, hashPassword, checkPassword } = require('./auth');
const { PATH_RE, ALLOWED_EXT, MAX_SOURCE_BYTES } = require('./validate');

// No 0/O/1/I/L: codes get read aloud and typed by students.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(7), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
const MAX_ASSIGNMENT_FILES = 50;

const isId = (v) => /^\d+$/.test(String(v));
const cleanName = (v, max) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, max) : '');
const slugify = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'assignment';
/** A folder name for a new item that no other item in the class uses yet: lab-1, lab-1-2, lab-1-3, ... */
async function uniqueFolder(db, classId, title) {
  const base = slugify(title);
  const taken = new Set((await db.query('SELECT folder FROM assignments WHERE class_id = $1', [classId])).rows.map((r) => r.folder));
  let name = base;
  for (let n = 2; taken.has(name); n++) name = `${base.slice(0, 26)}-${n}`;
  return name;
}

const userLabel = (u) => u.username || u.email;

/**
 * Classes under /api/classes. Teachers (and the super admin) own classes; students join with a code.
 * Teachers can read a student's workspace only for students in one of their own classes.
 */
function createClassesRouter({ db, logger = console }) {
  const router = express.Router();
  router.use(express.json({ limit: '3mb' }));
  const { wrap, requireUser, requireRole } = createGuards(db);
  const teachers = requireRole('teacher', 'superadmin');
  const joinLimiter = createLimiter({ max: 10, windowMs: 15 * 60 * 1000 });

  router.use(csrfGuard);

  /** Load :id and make sure the signed-in teacher owns it. */
  const ownClass = wrap(async (req, res, next) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad class id.' });
    const { rows } = await db.query('SELECT id, name, code FROM classes WHERE id = $1 AND teacher_id = $2', [req.params.id, req.user.id]);
    if (!rows[0]) return res.status(404).json({ error: 'No such class.' });
    req.klass = rows[0];
    return next();
  });

  /** :uid must be a student in the teacher's class. */
  const classStudent = wrap(async (req, res, next) => {
    if (!isId(req.params.uid)) return res.status(400).json({ error: 'Bad student id.' });
    const { rows } = await db.query(
      'SELECT u.id, u.username, u.email FROM class_members m JOIN users u ON u.id = m.user_id WHERE m.class_id = $1 AND m.user_id = $2',
      [req.klass.id, req.params.uid]);
    if (!rows[0]) return res.status(404).json({ error: 'That student is not in this class.' });
    req.student = rows[0];
    return next();
  });

  // ---- List my classes ----
  router.get('/', requireUser, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (req.user.role === 'teacher' || req.user.role === 'superadmin') {
      const { rows } = await db.query(
        `SELECT c.id, c.name, c.code, c.created_at AS "createdAt", (SELECT count(*)::int FROM class_members m WHERE m.class_id = c.id) AS "studentCount"
         FROM classes c WHERE c.teacher_id = $1 ORDER BY c.id DESC`, [req.user.id]);
      return res.json({ role: 'teacher', classes: rows });
    }
    const { rows } = await db.query(
      `SELECT c.id, c.name, COALESCE(t.username, t.email) AS "teacher"
       FROM class_members m JOIN classes c ON c.id = m.class_id JOIN users t ON t.id = c.teacher_id
       WHERE m.user_id = $1 ORDER BY m.joined_at DESC`, [req.user.id]);
    return res.json({ role: 'student', classes: rows });
  }));

  // ---- Teacher: create / delete a class ----
  router.post('/', teachers, wrap(async (req, res) => {
    const name = cleanName(req.body && req.body.name, 60);
    if (!name) return res.status(400).json({ error: 'Give the class a name.' });
    for (let i = 0; i < 5; i++) {
      try {
        const { rows } = await db.query('INSERT INTO classes (teacher_id, name, code) VALUES ($1, $2, $3) RETURNING id, name, code', [req.user.id, name, newCode()]);
        return res.status(201).json({ class: { ...rows[0], studentCount: 0 } });
      } catch (err) {
        if (err.code !== '23505') throw err; // code collision: try another
      }
    }
    return res.status(500).json({ error: 'Could not make a class code. Try again.' });
  }));

  router.delete('/:id', teachers, ownClass, wrap(async (req, res) => {
    await db.query('DELETE FROM classes WHERE id = $1', [req.klass.id]);
    res.json({ ok: true });
  }));

  // ---- Student: join / leave ----
  router.post('/join', requireRole('student'), wrap(async (req, res) => {
    if (!joinLimiter.take(`join:${req.user.id}`)) return res.status(429).json({ error: 'Too many tries. Wait a few minutes.' });
    const code = cleanName(req.body && req.body.code, 20).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const { rows } = await db.query('SELECT id, name FROM classes WHERE code = $1', [code]);
    if (!rows[0]) return res.status(404).json({ error: 'No class has that code.' });
    await db.query('INSERT INTO class_members (class_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [rows[0].id, req.user.id]);
    res.json({ class: rows[0] });
  }));

  router.delete('/:id/membership', requireRole('student'), wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad class id.' });
    await db.query('DELETE FROM class_members WHERE class_id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  }));

  // ---- One class: roster (teacher) and assignments (teacher or member) ----
  router.get('/:id', requireUser, wrap(async (req, res) => {
    if (!isId(req.params.id)) return res.status(400).json({ error: 'Bad class id.' });
    const { rows } = await db.query(
      `SELECT c.id, c.name, c.code, c.teacher_id, COALESCE(t.username, t.email) AS teacher
       FROM classes c JOIN users t ON t.id = c.teacher_id WHERE c.id = $1`, [req.params.id]);
    const klass = rows[0];
    const isTeacher = klass && String(klass.teacher_id) === String(req.user.id);
    let isMember = false;
    if (klass && !isTeacher) {
      isMember = (await db.query('SELECT 1 FROM class_members WHERE class_id = $1 AND user_id = $2', [klass.id, req.user.id])).rowCount > 0;
    }
    if (!klass || (!isTeacher && !isMember)) return res.status(404).json({ error: 'No such class.' });

    const assignments = (await db.query(
      `SELECT id, title, folder, kind, created_at AS "createdAt", (SELECT count(*)::int FROM jsonb_object_keys(files)) AS "fileCount"
       FROM assignments WHERE class_id = $1 ORDER BY id DESC`, [klass.id])).rows;
    const out = { id: klass.id, name: klass.name, teacher: klass.teacher, isTeacher, assignments };
    if (isTeacher) {
      out.code = klass.code;
      out.students = (await db.query(
        `SELECT u.id, u.username, u.email, m.joined_at AS "joinedAt", w.updated_at AS "savedAt",
                (SELECT count(*)::int FROM jsonb_object_keys(w.data->'files')) AS "fileCount"
         FROM class_members m JOIN users u ON u.id = m.user_id LEFT JOIN workspaces w ON w.user_id = u.id
         WHERE m.class_id = $1 ORDER BY lower(COALESCE(u.username, u.email))`, [klass.id])).rows;
    }
    res.set('Cache-Control', 'no-store');
    res.json({ class: out });
  }));

  // ---- Teacher: roster actions ----
  router.delete('/:id/students/:uid', teachers, ownClass, classStudent, wrap(async (req, res) => {
    await db.query('DELETE FROM class_members WHERE class_id = $1 AND user_id = $2', [req.klass.id, req.student.id]);
    res.json({ ok: true });
  }));

  router.post('/:id/students/:uid/password', teachers, ownClass, classStudent, wrap(async (req, res) => {
    const pw = req.body && req.body.newPassword;
    const bad = checkPassword(pw);
    if (bad) return res.status(400).json({ error: bad });
    await db.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await hashPassword(pw), req.student.id]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [req.student.id]); // signed out everywhere
    res.json({ ok: true });
  }));

  // A student's saved files, read-only. Used by the "View code" / "Run" link on the roster.
  router.get('/:id/students/:uid/workspace', teachers, ownClass, classStudent, wrap(async (req, res) => {
    const { rows } = await db.query('SELECT data, updated_at FROM workspaces WHERE user_id = $1', [req.student.id]);
    res.set('Cache-Control', 'no-store');
    res.json({ student: userLabel(req.student), className: req.klass.name, workspace: rows[0] ? rows[0].data : null, updatedAt: rows[0] ? rows[0].updated_at : null });
  }));

  // ---- Teacher: assignments (starter code taken from the teacher's own saved files) ----
  router.post('/:id/assignments', teachers, ownClass, wrap(async (req, res) => {
    const title = cleanName(req.body && req.body.title, 60);
    const folder = typeof (req.body && req.body.folder) === 'string' ? req.body.folder.replace(/\/+$/, '') : '';
    if (!title) return res.status(400).json({ error: 'Give the assignment a title.' });
    if (folder && !PATH_RE.test(folder)) return res.status(400).json({ error: 'Bad folder name.' });
    const ws = (await db.query('SELECT data FROM workspaces WHERE user_id = $1', [req.user.id])).rows[0];
    if (!ws) return res.status(400).json({ error: 'Save some files to your account first, then pick them here.' });
    const files = {};
    for (const [path, text] of Object.entries(ws.data.files)) {
      if (!folder) files[path] = text;
      else if (path.startsWith(`${folder}/`)) files[path.slice(folder.length + 1)] = text;
    }
    const n = Object.keys(files).length;
    if (n === 0) return res.status(400).json({ error: folder ? `Your saved files have no folder called "${folder}".` : 'You have no saved files.' });
    if (n > MAX_ASSIGNMENT_FILES) return res.status(400).json({ error: `An assignment can hold at most ${MAX_ASSIGNMENT_FILES} files.` });
    const { rows } = await db.query(
      'INSERT INTO assignments (class_id, title, folder, files) VALUES ($1, $2, $3, $4) RETURNING id, title, folder',
      [req.klass.id, title, await uniqueFolder(db, req.klass.id, title), JSON.stringify(files)]);
    res.status(201).json({ assignment: { ...rows[0], fileCount: n } });
  }));

  // ---- Teacher: share one program with the class, straight from the editor ----
  router.post('/:id/shares', teachers, ownClass, wrap(async (req, res) => {
    const { path, content } = req.body || {};
    if (typeof path !== 'string' || !PATH_RE.test(path) || !ALLOWED_EXT.test(path)) return res.status(400).json({ error: 'That file cannot be shared.' });
    if (typeof content !== 'string' || content.trim() === '') return res.status(400).json({ error: 'The file is empty.' });
    if (Buffer.byteLength(content, 'utf8') > MAX_SOURCE_BYTES) return res.status(400).json({ error: 'The file is larger than 64 KB.' });
    const name = path.split('/').pop();
    const title = cleanName(req.body.title, 60) || name;
    const { rows } = await db.query(
      "INSERT INTO assignments (class_id, title, folder, files, kind) VALUES ($1, $2, $3, $4, 'shared') RETURNING id, title, folder, kind",
      [req.klass.id, title, await uniqueFolder(db, req.klass.id, title), JSON.stringify({ [name]: content })]);
    res.status(201).json({ shared: { ...rows[0], className: req.klass.name } });
  }));

  router.delete('/:id/assignments/:aid', teachers, ownClass, wrap(async (req, res) => {
    if (!isId(req.params.aid)) return res.status(400).json({ error: 'Bad assignment id.' });
    const r = await db.query('DELETE FROM assignments WHERE id = $1 AND class_id = $2', [req.params.aid, req.klass.id]);
    res.status(r.rowCount ? 200 : 404).json(r.rowCount ? { ok: true } : { error: 'No such assignment.' });
  }));

  // ---- Student: copy an assignment's starter files into my workspace, in a folder of its own ----
  router.post('/:id/assignments/:aid/start', requireRole('student'), wrap(async (req, res) => {
    if (!isId(req.params.id) || !isId(req.params.aid)) return res.status(400).json({ error: 'Bad id.' });
    const a = (await db.query(
      `SELECT a.title, a.folder, a.files FROM assignments a JOIN class_members m ON m.class_id = a.class_id
       WHERE a.id = $1 AND a.class_id = $2 AND m.user_id = $3`, [req.params.aid, req.params.id, req.user.id])).rows[0];
    if (!a) return res.status(404).json({ error: 'No such assignment.' });

    const cur = (await db.query('SELECT data FROM workspaces WHERE user_id = $1', [req.user.id])).rows[0];
    const data = cur ? cur.data : { files: {}, open: undefined, collapsed: {} };
    const prefix = `${a.folder}/`;
    const exists = Object.keys(data.files).some((p) => p.startsWith(prefix));
    if (exists && !(req.body && req.body.overwrite === true)) {
      return res.status(409).json({ error: `You already have a folder called "${a.folder}". Starting again replaces the files in it.`, folder: a.folder });
    }
    const files = Object.fromEntries(Object.entries(data.files).filter(([p]) => !p.startsWith(prefix)));
    for (const [path, text] of Object.entries(a.files)) {
      if (!ALLOWED_EXT.test(path)) continue;
      files[prefix + path] = text;
    }
    const first = Object.keys(a.files).sort()[0];
    const c = cleanWorkspace({ files, open: first ? prefix + first : data.open, collapsed: data.collapsed });
    if (c.error) return res.status(400).json({ error: c.error });
    await db.query(
      `INSERT INTO workspaces (user_id, data) VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [req.user.id, JSON.stringify(c.value)]);
    res.json({ ok: true, folder: a.folder });
  }));

  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Too much data.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
    logger.error('Class route error:', err);
    return res.status(500).json({ error: 'Something went wrong.' });
  });

  return router;
}

module.exports = { createClassesRouter };
