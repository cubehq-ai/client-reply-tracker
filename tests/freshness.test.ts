import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { inboxFacets, listQueue } from '../src/api/queues.js';
import type { SessionUser } from '../src/api/auth.js';
import { config } from '../src/lib/config.js';
import { syncAllMailboxes } from '../src/sync/mailboxSync.js';
import { freshHarness, setupSchema, teardown } from './helpers.js';

const admin: SessionUser = { id: 0, email: 'dev@cubehq.ai', name: 'Dev', role: 'admin', canSendAsShared: true };

beforeAll(async () => { await setupSchema(); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await freshHarness();
  await syncAllMailboxes();
  const row = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [admin.email]);
  admin.id = Number(row[0]!.id);
});

/** Puts every open item at a known age so the split is unambiguous. */
async function ageOpenItems(hours: number): Promise<void> {
  await query(
    `UPDATE items SET last_external_at = now() - ($1 || ' hours')::interval WHERE state = 'needs_reply'`,
    [String(hours)],
  );
}

describe('unresponded threshold', () => {
  it('defaults to 12 hours', () => {
    expect(config.org.unrespondedAfterHours).toBe(12);
  });

  it('counts an item older than the threshold as not replied', async () => {
    await ageOpenItems(20);
    const facets = await inboxFacets(admin, {});
    expect(facets.notReplied).toBeGreaterThan(0);
    expect(facets.fresh).toBe(0);
    expect(facets.thresholdHours).toBe(12);
  });

  it('treats a recent one as still in flow, not as unresponded', async () => {
    await ageOpenItems(2);
    const facets = await inboxFacets(admin, {});
    expect(facets.notReplied).toBe(0);
    expect(facets.fresh).toBeGreaterThan(0);
  });

  it('the two buckets always add up to the open items', async () => {
    await ageOpenItems(20);
    const facets = await inboxFacets(admin, {});
    expect(facets.notReplied + facets.fresh).toBe(facets.status.needs_reply ?? 0);
  });

  it('filters the list itself, not only the counts', async () => {
    await ageOpenItems(20);
    const aged = await listQueue(admin, 'inbox', { status: ['needs_reply'], freshness: 'aged' });
    const fresh = await listQueue(admin, 'inbox', { status: ['needs_reply'], freshness: 'fresh' });
    expect(aged.total).toBeGreaterThan(0);
    expect(fresh.total).toBe(0);
  });

  it('moves an item between buckets as it ages past the threshold', async () => {
    await ageOpenItems(11);
    expect((await inboxFacets(admin, {})).notReplied).toBe(0);
    await ageOpenItems(13);
    expect((await inboxFacets(admin, {})).notReplied).toBeGreaterThan(0);
  });
});
