import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { loadOrgContext } from '../src/pipeline/context.js';
import { ingestMessage } from '../src/pipeline/ingest.js';
import { syncAllMailboxes } from '../src/sync/mailboxSync.js';
import type { RawMessage } from '../src/gmail/types.js';
import { freshHarness, itemBySubject, setupSchema, statesBySubject, teardown, type Harness } from './helpers.js';

let h: Harness;

beforeAll(async () => { await setupSchema(); });
afterAll(async () => { await teardown(); });
beforeEach(async () => { h = await freshHarness(); });

describe('full fixture sync', () => {
  it('puts every fixture thread in the state the spec requires', async () => {
    await syncAllMailboxes();
    const states = await statesBySubject();

    // Client asked a question, nobody answered.
    expect(states['Q3 invoice discrepancy']).toBe('needs_reply');
    // Replied from a different mailbox than the one that received it.
    expect(states['Renewal terms']).toBe('no_reply_needed');
    // Client mail Gmail filed under Updates stays visible.
    expect(states['Integration timeline?']).toBe('needs_reply');
    // Machine-generated mail is closed.
    expect(states['Last chance: 40% off analytics seats']).toBe('no_reply_needed');
    expect(states['Automatic reply: Project sync']).toBe('no_reply_needed');
    expect(states['Delivery Status Notification (Failure)']).toBe('no_reply_needed');
    expect(states['Accepted: Quarterly review']).toBe('no_reply_needed');
    // "Thanks!" after our reply closes rather than reopening.
    expect(states['Shipping address update']).toBe('no_reply_needed');
    // A real follow-up after our reply does reopen.
    expect(states['Onboarding checklist']).toBe('needs_reply');
    // An internal-only forward is not a reply.
    expect(states['Contract redlines']).toBe('needs_reply');
  });

  it('creates no item for an internal-only thread', async () => {
    await syncAllMailboxes();
    const states = await statesBySubject();
    expect(states['Standup moved to 10:30']).toBeUndefined();
  });

  it('counts the reopen', async () => {
    await syncAllMailboxes();
    const item = await itemBySubject('Onboarding checklist');
    expect(item.reopen_count).toBe(1);
  });

  it('is idempotent: a second sync changes nothing', async () => {
    await syncAllMailboxes();
    const first = await statesBySubject();
    const countBefore = (await query('SELECT count(*)::int AS n FROM messages'))[0]!.n;

    await syncAllMailboxes();
    expect(await statesBySubject()).toEqual(first);
    expect((await query('SELECT count(*)::int AS n FROM messages'))[0]!.n).toBe(countBefore);
  });
});

describe('cross-mailbox dedupe', () => {
  it('makes one item from a group mail delivered to three mailboxes', async () => {
    await syncAllMailboxes();

    const rows = await query<{ n: string }>(
      `SELECT count(*)::int AS n FROM items i JOIN conversations c ON c.id = i.conversation_id
        WHERE c.subject = 'Need a W-9 for our records'`,
    );
    expect(Number(rows[0]!.n)).toBe(1);

    const copies = await query<{ n: string }>(
      `SELECT count(*)::int AS n FROM message_copies mc
         JOIN messages m ON m.id = mc.message_id
        WHERE m.rfc_message_id = '<group-1@acme.com>'`,
    );
    expect(Number(copies[0]!.n)).toBe(3);
  });

  it('classifies a message once however many mailboxes hold it', async () => {
    await syncAllMailboxes();
    const rows = await query<{ n: string }>(
      "SELECT count(*)::int AS n FROM classifications WHERE rfc_message_id = '<group-1@acme.com>'",
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it('routes a shared-inbox mail to the client account manager', async () => {
    await syncAllMailboxes();
    const rows = await query<{ email: string }>(
      `SELECT u.email FROM items i JOIN conversations c ON c.id = i.conversation_id
         JOIN users u ON u.id = i.owner_user_id
        WHERE c.subject = 'Need a W-9 for our records'`,
    );
    expect(rows[0]?.email).toBe('priya@cubehq.ai');
  });
});

describe('reply detection', () => {
  const base = (over: Partial<RawMessage> & { headers: Record<string, string> }): RawMessage => ({
    id: `inj-${Math.random().toString(36).slice(2)}`,
    threadId: 't-acme-1--priya',
    labelIds: ['SENT'],
    internalDateMs: Date.UTC(2026, 9, 9, 12, 0, 0),
    snippet: '',
    bodyText: 'Confirmed, reissuing now.',
    attachments: [],
    ...over,
  });

  it('marks replied when an internal message reaches the client', async () => {
    await syncAllMailboxes();
    expect((await statesBySubject())['Q3 invoice discrepancy']).toBe('needs_reply');

    const reply = base({
      headers: {
        from: 'priya@cubehq.ai', to: 'ops@acme.com', subject: 'Re: Q3 invoice discrepancy',
        'message-id': '<acme-reply@cubehq.ai>', 'in-reply-to': '<acme-1@acme.com>', references: '<acme-1@acme.com>',
      },
    });
    const ctx = await loadOrgContext();
    await ingestMessage(reply, 'priya@cubehq.ai', ctx);

    expect((await statesBySubject())['Q3 invoice discrepancy']).toBe('no_reply_needed');
  });

  it('does not count a reply that only went to colleagues', async () => {
    await syncAllMailboxes();
    const forward = base({
      headers: {
        from: 'priya@cubehq.ai', to: 'rahul@cubehq.ai', subject: 'Fwd: Q3 invoice discrepancy',
        'message-id': '<acme-fwd@cubehq.ai>', 'in-reply-to': '<acme-1@acme.com>', references: '<acme-1@acme.com>',
      },
    });
    const ctx = await loadOrgContext();
    await ingestMessage(forward, 'priya@cubehq.ai', ctx);

    expect((await statesBySubject())['Q3 invoice discrepancy']).toBe('needs_reply');
  });

  it('does not count a draft as a reply', async () => {
    await syncAllMailboxes();
    // The fixture set already contains a draft on this thread.
    expect((await statesBySubject())['Q3 invoice discrepancy']).toBe('needs_reply');
    const drafts = await query<{ n: string }>("SELECT count(*)::int AS n FROM messages WHERE is_draft = true");
    expect(Number(drafts[0]!.n)).toBeGreaterThan(0);
  });

  it('reopens a closed item when the client writes again', async () => {
    await syncAllMailboxes();
    const ctx = await loadOrgContext();

    const followUp = base({
      labelIds: ['INBOX'],
      internalDateMs: Date.UTC(2026, 9, 9, 13, 0, 0),
      bodyText: 'One more thing — can you also confirm the delivery date?',
      headers: {
        from: 'claire@northwind.io', to: 'priya@cubehq.ai', subject: 'Re: Renewal terms',
        'message-id': '<nw-3@northwind.io>', 'in-reply-to': '<nw-2@cubehq.ai>',
        references: '<nw-1@northwind.io> <nw-2@cubehq.ai>',
      },
    });
    await ingestMessage(followUp, 'priya@cubehq.ai', ctx);

    const item = await itemBySubject('Renewal terms');
    expect(item.state).toBe('needs_reply');
    expect(item.reopen_count).toBe(1);
  });
});

describe('deletion', () => {
  it('keeps the item while any mailbox still holds a copy', async () => {
    await syncAllMailboxes();
    h.gmail.deleteMessage('priya@cubehq.ai', (await gmailIdFor('<group-1@acme.com>', 'priya@cubehq.ai'))!);
    await syncAllMailboxes();
    expect((await statesBySubject())['Need a W-9 for our records']).toBe('needs_reply');
  });
});

async function gmailIdFor(rfcId: string, mailbox: string): Promise<string | null> {
  const rows = await query<{ gmail_message_id: string }>(
    `SELECT mc.gmail_message_id FROM message_copies mc
       JOIN messages m ON m.id = mc.message_id
       JOIN mailboxes mb ON mb.id = mc.mailbox_id
      WHERE m.rfc_message_id = $1 AND mb.email = $2`,
    [rfcId, mailbox],
  );
  return rows[0]?.gmail_message_id ?? null;
}

describe('low confidence flag', () => {
  it('survives re-ingesting the same message', async () => {
    await syncAllMailboxes();
    const before = await query<{ id: string; low_confidence: boolean; needs_reply_confidence: number }>(
      'SELECT id, low_confidence, needs_reply_confidence FROM items WHERE needs_reply_confidence IS NOT NULL ORDER BY id',
    );
    // A second pass re-ingests every message as a duplicate.
    await syncAllMailboxes();
    const after = await query<{ id: string; low_confidence: boolean }>(
      'SELECT id, low_confidence FROM items WHERE needs_reply_confidence IS NOT NULL ORDER BY id',
    );
    expect(after.map((r) => r.low_confidence)).toEqual(before.map((r) => r.low_confidence));
  });

  it('agrees with the stored confidence', async () => {
    await syncAllMailboxes();
    const inconsistent = await query<{ n: string }>(
      `SELECT count(*)::int AS n FROM items
        WHERE needs_reply_confidence IS NOT NULL
          AND low_confidence <> (needs_reply_confidence < 0.6)`,
    );
    expect(Number(inconsistent[0]!.n)).toBe(0);
  });
});
