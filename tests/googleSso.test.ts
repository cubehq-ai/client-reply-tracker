import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import {
  checkOAuthState, googleRedirectUri, newOAuthState, userFromGoogle, type GoogleIdentity,
} from '../src/api/auth.js';
import { setupSchema, teardown } from './helpers.js';

beforeAll(async () => { await setupSchema(); });
afterAll(async () => {
  await query("DELETE FROM users WHERE email LIKE '%@ssotest.cubehq.ai' OR email LIKE 'sso-%'");
  await teardown();
});

const identity = (over: Partial<GoogleIdentity> = {}): GoogleIdentity => ({
  sub: 'google-sub-1',
  email: 'sso-new@cubehq.ai',
  name: 'SSO New',
  emailVerified: true,
  hd: 'cubehq.ai',
  ...over,
});

/** A fake reply/request pair, enough for the cookie helpers. */
function fakeReply() {
  const headers: Record<string, string> = {};
  return { headers, header: (k: string, v: string) => { headers[k] = v; } } as any;
}
const reqWithCookie = (cookie: string) => ({ headers: { cookie } }) as any;

describe('google sso state', () => {
  it('round-trips a state value through the cookie', () => {
    const reply = fakeReply();
    const state = newOAuthState(reply);
    const cookie = reply.headers['Set-Cookie'].split(';')[0];
    expect(checkOAuthState(reqWithCookie(cookie), fakeReply(), state)).toBe(true);
  });

  it('rejects a forged or missing state', () => {
    const reply = fakeReply();
    newOAuthState(reply);
    const cookie = reply.headers['Set-Cookie'].split(';')[0];
    expect(checkOAuthState(reqWithCookie(cookie), fakeReply(), 'not-the-state')).toBe(false);
    expect(checkOAuthState(reqWithCookie(cookie), fakeReply(), undefined)).toBe(false);
    expect(checkOAuthState({ headers: {} } as any, fakeReply(), 'anything')).toBe(false);
  });

  it('uses the configured redirect uri verbatim', () => {
    const prev = process.env.GOOGLE_OAUTH_REDIRECT_URI;
    process.env.GOOGLE_OAUTH_REDIRECT_URI = 'https://example.test/api/auth/google/callback';
    expect(googleRedirectUri()).toBe('https://example.test/api/auth/google/callback');
    process.env.GOOGLE_OAUTH_REDIRECT_URI = prev;
  });
});

describe('resolving a google identity to a user', () => {
  it('adopts an account an admin created, keeping its role', async () => {
    await query(
      `INSERT INTO users (email, name, role, status) VALUES ($1,'Existing Admin','admin','active')
       ON CONFLICT (email) DO UPDATE SET role = 'admin', status = 'active'`,
      ['sso-admin@cubehq.ai'],
    );
    const user = await userFromGoogle(identity({ sub: 'sub-admin', email: 'sso-admin@cubehq.ai' }));
    expect(user.role).toBe('admin');
    const row = await query<{ google_sub: string }>(
      'SELECT google_sub FROM users WHERE email = $1', ['sso-admin@cubehq.ai']);
    expect(row[0]!.google_sub).toBe('sub-admin');
  });

  it('provisions a first-time org user as a plain member', async () => {
    const user = await userFromGoogle(identity({ sub: 'sub-new', email: 'sso-fresh@cubehq.ai' }));
    expect(user.role).toBe('member');
    expect(user.email).toBe('sso-fresh@cubehq.ai');
  });

  it('refuses an outside domain even when google verified it', async () => {
    await expect(userFromGoogle(identity({ sub: 'sub-out', email: 'someone@gmail.com' })))
      .rejects.toThrow(/organisation domain/);
  });

  it('refuses an unverified email', async () => {
    await expect(userFromGoogle(identity({ sub: 'sub-unv', emailVerified: false })))
      .rejects.toThrow(/unverified/);
  });

  it('refuses a suspended account', async () => {
    await query(
      `INSERT INTO users (email, name, role, status) VALUES ($1,'Gone','member','suspended')
       ON CONFLICT (email) DO UPDATE SET status = 'suspended'`,
      ['sso-suspended@cubehq.ai'],
    );
    await expect(userFromGoogle(identity({ sub: 'sub-susp', email: 'sso-suspended@cubehq.ai' })))
      .rejects.toThrow(/not active/);
  });

  it('matches on the stable sub after an email change', async () => {
    await userFromGoogle(identity({ sub: 'sub-stable', email: 'sso-before@cubehq.ai' }));
    const user = await userFromGoogle(identity({ sub: 'sub-stable', email: 'sso-before@cubehq.ai', name: 'Renamed' }));
    expect(user.email).toBe('sso-before@cubehq.ai');
    const rows = await query('SELECT id FROM users WHERE google_sub = $1', ['sub-stable']);
    expect(rows.length).toBe(1);
  });
});
