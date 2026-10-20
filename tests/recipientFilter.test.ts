import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { listQueue } from '../src/api/queues.js';
import { ingestMessage } from '../src/pipeline/ingest.js';
import { loadOrgContext } from '../src/pipeline/context.js';
import { syncAllMailboxes } from '../src/sync/mailboxSync.js';
import type { SessionUser } from '../src/api/auth.js';
import type { RawMessage } from '../src/gmail/types.js';
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

const MESSAGE_ID = '<cc-fanout-1@acme.test>';

/** The same client mail as it lands in each mailbox: one To, several Cc. */
const copyFor = (mailbox: string, mailboxes: string[]): RawMessage => ({
  id: `g-${mailbox}-${Math.random().toString(36).slice(2)}`,
  threadId: `t-${mailbox}`,
  labelIds: ['INBOX'],
  internalDateMs: Date.now(),
  snippet: '',
  bodyText: 'Could you confirm the next steps before Friday?',
  attachments: [],
  headers: {
    from: 'ops@acme.com',
    to: mailboxes[0]!,
    cc: mailboxes.slice(1).join(', '),
    subject: 'Re: Next steps',
    'message-id': MESSAGE_ID,
  },
});

async function userIds(emails: string[]): Promise<number[]> {
  const rows = await query<{ id: string }>('SELECT id FROM users WHERE email = ANY($1::citext[])', [emails]);
  return rows.map((r) => Number(r.id));
}

describe('the Recipient filter means everyone who received it', () => {
  it('finds mail for someone who was only on Cc', async () => {
    // One message, several watched mailboxes, stored once and owned by one
    // person. Matching the owner alone hid mail that is sitting in the other
    // recipients' own inboxes.
    const boxes = await query<{ email: string }>('SELECT email FROM mailboxes ORDER BY email LIMIT 3');
    if (boxes.length < 3) return;
    const mailboxes = boxes.map((b) => b.email);
    const ctx = await loadOrgContext();
    for (const mb of mailboxes) await ingestMessage(copyFor(mb, mailboxes), mb, ctx);

    // Stored once, however many mailboxes it reached.
    const stored = await query<{ n: string }>('SELECT count(*)::int AS n FROM messages WHERE rfc_message_id = $1', [MESSAGE_ID]);
    expect(Number(stored[0]!.n)).toBe(1);
    const copies = await query<{ n: string }>(
      `SELECT count(*)::int AS n FROM message_copies mc
         JOIN messages m ON m.id = mc.message_id WHERE m.rfc_message_id = $1`, [MESSAGE_ID]);
    expect(Number(copies[0]!.n)).toBe(3);

    const item = await query<{ id: string; owner: string | null }>(
      `SELECT i.id, u.email AS owner FROM items i
         JOIN messages m ON m.conversation_id = i.conversation_id
         LEFT JOIN users u ON u.id = i.owner_user_id
        WHERE m.rfc_message_id = $1`, [MESSAGE_ID]);
    expect(item).toHaveLength(1);
    const itemId = Number(item[0]!.id);
    const owner = item[0]!.owner;

    // Everyone it reached finds it, owner or not.
    for (const mailbox of mailboxes) {
      const ids = await userIds([mailbox]);
      if (ids.length === 0) continue;
      const found = await listQueue(admin, 'needs_reply', { ownerUserIds: ids });
      expect(
        found.items.some((i) => i.id === itemId),
        `${mailbox}${mailbox === owner ? ' (owner)' : ' (cc)'} should see it`,
      ).toBe(true);
    }
  });

  it('does not show it to someone who was never on it', async () => {
    const boxes = await query<{ email: string }>('SELECT email FROM mailboxes ORDER BY email LIMIT 4');
    if (boxes.length < 4) return;
    const mailboxes = boxes.slice(0, 3).map((b) => b.email);
    const ctx = await loadOrgContext();
    for (const mb of mailboxes) await ingestMessage(copyFor(mb, mailboxes), mb, ctx);

    const outsider = await userIds([boxes[3]!.email]);
    if (outsider.length === 0) return;
    const found = await listQueue(admin, 'needs_reply', { ownerUserIds: outsider });
    const item = await query<{ id: string }>(
      `SELECT i.id FROM items i JOIN messages m ON m.conversation_id = i.conversation_id
        WHERE m.rfc_message_id = $1`, [MESSAGE_ID]);
    expect(found.items.some((i) => i.id === Number(item[0]!.id))).toBe(false);
  });
});
