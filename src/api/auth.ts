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

// ---------- Google SSO ----------

const OAUTH_STATE_COOKIE = 'rq_oauth_state';

/**
 * The redirect URI must be byte-identical in the authorisation request, the
 * token exchange and the Google console entry, so all three read it from here.
 * The localhost default keeps a laptop working; anything deployed must set
 * GOOGLE_OAUTH_REDIRECT_URI, since Google rejects a mismatch outright.
 */
export function googleRedirectUri(): string {
  return process.env.GOOGLE_OAUTH_REDIRECT_URI
    ?? `http://localhost:${config.server.port}/api/auth/google/callback`;
}

/** Random state, parked in a short-lived cookie, so the callback can prove the
 *  flow started here and is not a forged redirect. */
export function newOAuthState(reply: FastifyReply): string {
  const state = randomBytes(16).toString('base64url');
  const parts = [
    `${OAUTH_STATE_COOKIE}=${state}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=600',
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  reply.header('Set-Cookie', parts.join('; '));
  return state;
}

/** True when the callback's state matches the cookie. Single use either way. */
export function checkOAuthState(req: FastifyRequest, reply: FastifyReply, state: string | undefined): boolean {
  const expected = readCookie(req, OAUTH_STATE_COOKIE);
  const clear = [`${OAUTH_STATE_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  reply.header('Set-Cookie', clear.join('; '));
  if (!expected || !state) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(state);
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  name: string | null;
  emailVerified: boolean;
  hd: string | null;
}

/**
 * Exchanges the one-time code for tokens and verifies the returned ID token's
 * signature and audience with Google's published keys. Verifying matters: the
 * code comes back through the user's browser, so nothing before this point is
 * trustworthy on its own.
 */
export async function exchangeGoogleCode(code: string): Promise<GoogleIdentity> {
  const { OAuth2Client } = await import('google-auth-library');
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID!;
  const client = new OAuth2Client(clientId, process.env.GOOGLE_OAUTH_CLIENT_SECRET!, googleRedirectUri());

  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) throw new HttpError(401, 'google returned no id_token');

  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId });
  const payload = ticket.getPayload();
  if (!payload?.sub || !payload.email) throw new HttpError(401, 'google id_token has no subject or email');

  return {
    sub: payload.sub,
    email: payload.email.toLowerCase(),
    name: payload.name ?? null,
    emailVerified: payload.email_verified === true,
    hd: payload.hd ?? null,
  };
}

/**
 * Resolves a verified Google identity to a local user.
 *
 * Matching is by `google_sub` first and email second: the sub is stable when
 * someone is renamed, and the email link is what adopts an account an admin
 * (or the roster sync) created earlier. A first sign-in from an org domain
 * provisions a plain member -- roles stay an admin's decision, never Google's.
 */
export async function userFromGoogle(identity: GoogleIdentity): Promise<SessionUser> {
  if (!identity.emailVerified) throw new HttpError(403, 'google account has an unverified email');

  const domain = identity.email.split('@')[1] ?? '';
  const allowed = config.org.domains.map((d) => d.toLowerCase());
  if (allowed.length && !allowed.includes(domain)) {
    throw new HttpError(403, `${identity.email} is not on an organisation domain`);
  }

  const existing = await one<{ id: string; status: string }>(
    'SELECT id, status FROM users WHERE google_sub = $1 OR email = $2',
    [identity.sub, identity.email],
  );

  if (existing) {
    if (existing.status !== 'active') throw new HttpError(403, 'this account is not active');
    await query(
      `UPDATE users SET google_sub = $1, name = COALESCE(name, $2), updated_at = now() WHERE id = $3`,
      [identity.sub, identity.name, existing.id],
    );
  } else {
    await query(
      `INSERT INTO users (email, name, role, status, google_sub)
       VALUES ($1, $2, 'member', 'active', $3)
       ON CONFLICT (email) DO UPDATE SET google_sub = EXCLUDED.google_sub`,
      [identity.email, identity.name, identity.sub],
    );
  }

  const user = await one<{ id: string; email: string; name: string | null; role: string; can_send_as_shared: boolean }>(
    `SELECT id, email, name, role, can_send_as_shared FROM users WHERE google_sub = $1`,
    [identity.sub],
  );
  if (!user) throw new HttpError(500, 'could not load the user after sign-in');

  return {
    id: Number(user.id),
    email: user.email,
    name: user.name,
    role: user.role as SessionUser['role'],
    canSendAsShared: user.can_send_as_shared,
  };
}
