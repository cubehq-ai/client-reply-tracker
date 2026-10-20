import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { hashPassword, verifyPassword } from '../src/api/auth.js';
import { setupSchema, teardown } from './helpers.js';

beforeAll(async () => { await setupSchema(); });
afterAll(async () => { await teardown(); });

/**
 * The deployed app is reachable from the internet and the seeded password is
 * the only thing in front of real client mail, so changing it must not
 * require writing a hash by hand.
 */
describe('changing a password', () => {
  it('replaces the hash and the old password stops working', async () => {
    const email = 'pwtest@cubehq.ai';
    await query(
      `INSERT INTO users (email, name, role, password_hash) VALUES ($1,'PW Test','member',$2)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [email, await hashPassword('the-old-password')],
    );

    await query('UPDATE users SET password_hash = $2 WHERE lower(email) = lower($1)',
      [email, await hashPassword('a-much-better-password')]);

    const row = await query<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE lower(email) = lower($1)', [email]);
    expect(await verifyPassword('a-much-better-password', row[0]!.password_hash)).toBe(true);
    expect(await verifyPassword('the-old-password', row[0]!.password_hash)).toBe(false);
    await query('DELETE FROM users WHERE lower(email) = lower($1)', [email]);
  });

  it('hashes rather than storing what was typed', async () => {
    const hash = await hashPassword('plaintext-never-stored');
    expect(hash).not.toContain('plaintext-never-stored');
    expect(hash.length).toBeGreaterThan(32);
  });
});
