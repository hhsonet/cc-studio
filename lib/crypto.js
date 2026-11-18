'use strict';

const crypto = require('node:crypto');

// Secrets at rest (GitHub tokens, the GitHub client secret): AES-256-GCM, stored as "iv.tag.ciphertext" (base64).

/** The 32-byte key from a base64 string, or null if it is missing or the wrong size. */
function parseKey(b64) {
  const key = Buffer.from(b64 || '', 'base64');
  return key.length === 32 ? key : null;
}

function encrypt(key, text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(key, packed) {
  const [iv, tag, enc] = String(packed).split('.').map((s) => Buffer.from(s, 'base64'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

module.exports = { parseKey, encrypt, decrypt };
