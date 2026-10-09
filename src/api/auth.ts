import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { one, query } from '../db/pool.js';
import { config } from '../lib/config.js';

const scrypt = promisify(scryptCb) as (p: string, s: Buffer, k: number) => Promise<Buffer>;

const SESSION_COOKIE = 'rq_session';
const SESSION_DAYS = 14;

export interface SessionUser {
  id: number;
  email: string;
  name: string | null;
  role: 'member' | 'manager' | 'admin';
  canSendAsShared: boolean;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const derived = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  // Constant-time compare so a wrong password cannot be timed out character by character.
  return expected.length === derived.length && timingSafeEqual(expected, derived);
}

export async function createSession(userId: number, req: FastifyRequest): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await query('INSERT INTO sessions (id, user_id, expires_at, user_agent, ip) VALUES ($1,$2,$3,$4,$5)', [
    id, userId, expiresAt, req.headers['user-agent'] ?? null, req.ip,
  ]);
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  return { id, expiresAt };
}

export function setSessionCookie(reply: FastifyReply, id: string, expiresAt: Date): void {
  const parts = [
    `${SESSION_COOKIE}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  // Secure is omitted on localhost so the cookie works over plain http in dev.
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(reply: FastifyReply): void {
  reply.header('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=');
  }
  return null;
}

export async function currentUser(req: FastifyRequest): Promise<SessionUser | null> {
  const sessionId = readCookie(req, SESSION_COOKIE);
  if (sessionId) {
    const row = await one<{ id: string; email: string; name: string | null; role: string; can_send_as_shared: boolean }>(
      `SELECT u.id, u.email, u.name, u.role, u.can_send_as_shared
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = $1 AND s.expires_at > now() AND u.status = 'active'`,
      [sessionId],
    );
    if (row) {
      return { id: Number(row.id), email: row.email, name: row.name, role: row.role as SessionUser['role'], canSendAsShared: row.can_send_as_shared };
    }
  }

  // Dev convenience only: never reachable in production builds.
  if (process.env.NODE_ENV !== 'production' && process.env.DEV_AUTH_BYPASS === 'true') {
    const row = await one<{ id: string; email: string; name: string | null; role: string; can_send_as_shared: boolean }>(
      'SELECT id, email, name, role, can_send_as_shared FROM users WHERE email = $1',
      [config.server.devUserEmail],
    );
    if (row) return { id: Number(row.id), email: row.email, name: row.name, role: row.role as SessionUser['role'], canSendAsShared: row.can_send_as_shared };
  }

  return null;
}

export async function destroySession(req: FastifyRequest): Promise<void> {
  const sessionId = readCookie(req, 'rq_session');
  if (sessionId) await query('DELETE FROM sessions WHERE id = $1', [sessionId]);
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Throws 401 when signed out, so route handlers can assume a user. */
export async function requireUser(req: FastifyRequest): Promise<SessionUser> {
  const user = await currentUser(req);
  if (!user) throw new HttpError(401, 'not signed in');
  return user;
}

export function requireRole(user: SessionUser, roles: SessionUser['role'][]): void {
  if (!roles.includes(user.role)) throw new HttpError(403, `requires role: ${roles.join(' or ')}`);
}

/** True when Google SSO is configured; the UI shows the button either way. */
export function googleSsoConfigured(): boolean {
  return Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET);
}
