import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { syncHealth } from '../src/api/syncHealth.js';
import { setupSchema, teardown } from './helpers.js';

beforeAll(async () => { await setupSchema(); });
afterAll(async () => {
  await query("DELETE FROM mailboxes WHERE email LIKE '%@healthtest.cubehq.ai'");
  await teardown();
});

/**
 * A stale banner that does not say why sent someone to the worker logs for a
 * reason the database already had: every mailbox failing on a key file that
 * does not exist in the container.
 */
describe('sync health surfaces why mailboxes are stalled', () => {
  it('reports the error the stalled mailboxes share', async () => {
    const err = 'Could not read the service account key at ./nope.json';
    await query(
      `INSERT INTO mailboxes (email, kind, status, last_synced_at, last_error)
       VALUES ($1,'user','active', now() - interval '3 hours', $2)
       ON CONFLICT (email) DO UPDATE SET last_error = EXCLUDED.last_error,
         last_synced_at = EXCLUDED.last_synced_at, status = 'active'`,
      ['stalled@healthtest.cubehq.ai', err],
    );

    const health = await syncHealth(30);
    expect(health.lastError).toContain('Could not read the service account key');
    expect(health.mailboxesWithErrors).toBeGreaterThan(0);
  });

  it('reports no error when mailboxes are merely quiet', async () => {
    await query("DELETE FROM mailboxes WHERE email LIKE '%@healthtest.cubehq.ai'");
    await query(
      `INSERT INTO mailboxes (email, kind, status, last_synced_at, last_error)
       VALUES ($1,'user','active', now(), NULL)
       ON CONFLICT (email) DO UPDATE SET last_error = NULL, last_synced_at = now()`,
      ['quiet@healthtest.cubehq.ai'],
    );
    const health = await syncHealth(30);
    expect(health.lastError).toBeNull();
  });
});
