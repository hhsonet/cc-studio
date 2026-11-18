'use strict';

// Create (or reset) the super admin account.
//   ADMIN_PASSWORD='...' node scripts/create-superadmin.js <username>
// The password is read from the environment so it never lands in the repo or in `ps` output.
// Running it again for the same username resets that account's password and role.

require('dotenv').config();
const { createDb } = require('../lib/db');
const { hashPassword } = require('../lib/auth');

async function main() {
  const username = (process.argv[2] || '').trim();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!/^[A-Za-z0-9_.-]{2,32}$/.test(username)) throw new Error('Usage: ADMIN_PASSWORD=... node scripts/create-superadmin.js <username> (2-32 letters, digits, _ . -)');
  if (password.length < 8) throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set.');

  const db = await createDb(process.env.DATABASE_URL);
  try {
    const hash = await hashPassword(password);
    const { rows } = await db.query(
      `INSERT INTO users (username, password_hash, role) VALUES ($1, $2, 'superadmin')
       ON CONFLICT (lower(username)) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = 'superadmin'
       RETURNING id, username, role`, [username, hash]);
    await db.query('DELETE FROM sessions WHERE user_id = $1', [rows[0].id]); // a reset signs out old sessions
    console.log(`Super admin ready: ${rows[0].username} (id ${rows[0].id})`);
  } finally {
    await db.close();
  }
}

main().catch((err) => { console.error(err.message); process.exit(1); });
