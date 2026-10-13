import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { listQueue } from '../src/api/queues.js';
import type { SessionUser } from '../src/api/auth.js';
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

describe('multi-select filters', () => {
  it('an empty list means no restriction', async () => {
    const all = await listQueue(admin, 'inbox', {});
    const empty = await listQueue(admin, 'inbox', { priorities: [], clientIds: [], ages: [] });
    expect(empty.total).toBe(all.total);
  });

  it('several priorities OR together rather than narrowing', async () => {
    const high = await listQueue(admin, 'inbox', { priorities: ['high'] });
    const normal = await listQueue(admin, 'inbox', { priorities: ['normal'] });
    const both = await listQueue(admin, 'inbox', { priorities: ['high', 'normal'] });
    expect(both.total).toBe(high.total + normal.total);
  });

  it('several clients OR together', async () => {
    const clients = await query<{ id: string }>('SELECT id FROM clients ORDER BY id LIMIT 2');
    if (clients.length < 2) return;
    const a = await listQueue(admin, 'inbox', { clientIds: [Number(clients[0]!.id)] });
    const b = await listQueue(admin, 'inbox', { clientIds: [Number(clients[1]!.id)] });
    const both = await listQueue(admin, 'inbox', { clientIds: [Number(clients[0]!.id), Number(clients[1]!.id)] });
    expect(both.total).toBe(a.total + b.total);
  });

  it('age buckets OR together and partition the set', async () => {
    const buckets = ['4h', '24h', '3d', 'older'] as const;
    const parts = await Promise.all(buckets.map((b) => listQueue(admin, 'inbox', { ages: [b] })));
    const all = await listQueue(admin, 'inbox', { ages: [...buckets] });
    expect(all.total).toBe(parts.reduce((n, p) => n + p.total, 0));
  });

  it('different filters still AND with each other', async () => {
    const byPriority = await listQueue(admin, 'inbox', { priorities: ['high', 'normal', 'low'] });
    const narrowed = await listQueue(admin, 'inbox', { priorities: ['high', 'normal', 'low'], status: ['needs_reply'] });
    expect(narrowed.total).toBeLessThanOrEqual(byPriority.total);
  });

  it('selecting every option matches selecting none', async () => {
    const none = await listQueue(admin, 'inbox', {});
    const all = await listQueue(admin, 'inbox', { priorities: ['high', 'normal', 'low'] });
    expect(all.total).toBe(none.total);
  });
});
