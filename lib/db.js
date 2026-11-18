'use strict';

const { Pool } = require('pg');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON users (lower(email));

-- Added after the first release: usernames (no '@'), roles, and accounts without an email.
ALTER TABLE users ALTER COLUMN email DROP NOT NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'student';
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'student';
UPDATE users SET role = 'student' WHERE role = 'user';
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower ON users (lower(username));
-- The GitHub account (numeric id, which never changes) that may sign in as this user.
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS users_github_id ON users (github_id) WHERE github_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions (expires_at);

-- One cloud workspace per user: { files, open, collapsed } as a single JSON document.
CREATE TABLE IF NOT EXISTS workspaces (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Classes: a teacher owns a class, students join with its code.
CREATE TABLE IF NOT EXISTS classes (
  id         BIGSERIAL PRIMARY KEY,
  teacher_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  code       TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS classes_teacher ON classes (teacher_id);

CREATE TABLE IF NOT EXISTS class_members (
  class_id  BIGINT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (class_id, user_id)
);
CREATE INDEX IF NOT EXISTS class_members_user ON class_members (user_id);

-- Starter code a teacher hands out: { relative/path.c: text }.
CREATE TABLE IF NOT EXISTS assignments (
  id         BIGSERIAL PRIMARY KEY,
  class_id   BIGINT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  folder     TEXT NOT NULL,
  files      JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS assignments_class ON assignments (class_id);
-- 'assignment' (a folder of starter files) or 'shared' (one program the teacher sent from the editor).
ALTER TABLE assignments ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'assignment';

-- A user's linked GitHub account, and the one repository they work with (repo). The OAuth token is stored encrypted (see lib/github.js).
CREATE TABLE IF NOT EXISTS github_links (
  user_id      BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  github_login TEXT NOT NULL,
  token_enc    TEXT NOT NULL,
  scope        TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE github_links ADD COLUMN IF NOT EXISTS repo TEXT;

-- Settings an admin changes at run time (the GitHub app's Client ID, secret, public address). Secrets are encrypted.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  secret     BOOLEAN NOT NULL DEFAULT false,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by BIGINT REFERENCES users(id) ON DELETE SET NULL
);
`;

/** Connect to Postgres and make sure the tables exist. `query` is pool.query. */
async function createDb(connectionString) {
  const pool = new Pool({ connectionString, max: 10 });
  // A dropped idle connection must not crash the process.
  pool.on('error', (err) => console.error('Postgres pool error:', err.message));
  await pool.query(SCHEMA);
  return { pool, query: (text, params) => pool.query(text, params), close: () => pool.end() };
}

module.exports = { createDb };