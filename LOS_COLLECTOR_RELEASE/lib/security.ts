import crypto from 'node:crypto';
import { cookies } from 'next/headers';
import { query } from './db';

const COOKIE = 'los_session';
const days = 30;
function secret() { return process.env.SESSION_SECRET || 'development-only-change-me-please-32-chars'; }
export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${hash}`;
}
export function verifyPassword(password: string, stored: string) {
  const [kind, salt, hash] = stored.split(':');
  if (kind !== 'scrypt' || !salt || !hash) return false;
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(hash, 'hex'));
}
export function tokenHash(token: string) { return crypto.createHash('sha256').update(token).digest('hex'); }
export function randomToken() { return crypto.randomBytes(48).toString('base64url'); }
export function signInternal(value: string) { return crypto.createHmac('sha256', secret()).update(value).digest('hex'); }
export async function createSession(userId: string) {
  const rawToken = randomToken();
  const token = `${rawToken}.${signInternal(rawToken)}`;
  const expires = new Date(Date.now() + days * 86400000);
  await query('DELETE FROM sessions WHERE user_id=$1 OR expires_at < now()', [userId]);
  await query('INSERT INTO sessions(user_id, token_hash, expires_at) VALUES($1,$2,$3)', [userId, tokenHash(token), expires]);
  const jar = await cookies();
  jar.set(COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', path: '/', expires });
}
export async function clearSession() {
  const jar = await cookies(); const token = jar.get(COOKIE)?.value;
  if (token) await query('DELETE FROM sessions WHERE token_hash=$1', [tokenHash(token)]);
  jar.delete(COOKIE);
}
export async function currentUser() {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  const { rows } = await query<{id:string,email:string,role:string}>('SELECT u.id,u.email,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()', [tokenHash(token)]);
  return rows[0] || null;
}
export async function requireUser() { const user = await currentUser(); if (!user) throw new Error('UNAUTHORIZED'); return user; }
