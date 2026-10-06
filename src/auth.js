import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const derive = promisify(scrypt);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, options);
  return `scrypt$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password, stored) {
  const [algorithm, salt, hash] = stored.split('$');
  if (algorithm !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{128}$/.test(hash)) return false;
  const key = await derive(password, salt, 64, options);
  return timingSafeEqual(key, Buffer.from(hash, 'hex'));
}
export const tokenHash = token => createHash('sha256').update(token).digest('hex');
export async function createSession(db, userId, ttlHours) {
  const token = randomBytes(32).toString('hex');
  const now = Date.now(), expiresAt = now + ttlHours * 3600000;
  await db.run('DELETE FROM sessions WHERE expires_at <= ?', now);
  await db.run('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)', tokenHash(token), userId, expiresAt, now);
  return { token, tokenType: 'Bearer', expiresAt: new Date(expiresAt).toISOString() };
}
