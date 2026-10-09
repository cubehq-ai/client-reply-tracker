import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query, tx } from '../src/db/pool.js';
import { recomputeItemState } from '../src/pipeline/stateMachine.js';
import { loadOrgContext } from '../src/pipeline/context.js';
import { ingestMessage } from '../src/pipeline/ingest.js';
import { syncAllMailboxes } from '../src/sync/mailboxSync.js';
import { sweepStuckSends, wakeSnoozed } from '../src/sync/followup.js';
import { handledElsewhere, ignoreItem, snoozeItem } from '../src/api/actions.js';
import type { SessionUser } from '../src/api/auth.js';
import type { RawMessage } from '../src/gmail/types.js';
import { freshHarness, itemBySubject, setupSchema, teardown } from './helpers.js';

beforeAll(async () => { await setupSchema(); });
afterAll(async () => { await teardown(); });
const admin: SessionUser = { id: 0, email: 'dev@cubehq.ai', name: 'Dev', role: 'admin', canSendAsShared: true };

beforeEach(async () => {
  await freshHarness();
  await syncAllMailboxes();
  const row = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [admin.email]);
  admin.id = Number(row[0]!.id);
});

function external(over: Partial<RawMessage> & { headers: Record<string, string> }): RawMessage {
  return {
    id: `ext-${Math.random().toString(36).slice(2)}`,
    threadId: 't-acme-1--priya',
    labelIds: ['INBOX'],
    internalDateMs: Date.now(),
    snippet: '',
    bodyText: 'Any update on this? We are blocked.',
    attachments: [],
    ...over,
  };
}

const followUp = (messageId: string) => external({
  headers: {
    from: 'ops@acme.com', to: 'priya@cubehq.ai', subject: 'Re: Q3 invoice discrepancy',
    'message-id': messageId, 'in-reply-to': '<acme-1@acme.com>', references: '<acme-1@acme.com>',
  },
});

describe('snooze transitions', () => {
  it('wakes when the snooze time passes', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await snoozeItem(admin, Number(item.id), new Date(Date.now() + 3_600_000));
    await query("UPDATE items SET snoozed_until = now() - interval '1 minute' WHERE id = $1", [item.id]);
    expect(await wakeSnoozed()).toBe(1);
    expect((await itemBySubject('Q3 invoice discrepancy')).state).toBe('needs_reply');
  });

  it('wakes early when the client writes again', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await snoozeItem(admin, Number(item.id), new Date(Date.now() + 7 * 86_400_000));
    const ctx = await loadOrgContext();
    await ingestMessage(followUp('<acme-followup-1@acme.com>'), 'priya@cubehq.ai', ctx);
    expect((await itemBySubject('Q3 invoice discrepancy')).state).toBe('needs_reply');
  });

  it('stays asleep when nothing new arrives', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await snoozeItem(admin, Number(item.id), new Date(Date.now() + 7 * 86_400_000));
    await tx((c) => recomputeItemState(c, Number(item.conversation_id)));
    expect((await itemBySubject('Q3 invoice discrepancy')).state).toBe('snoozed');
  });
});

describe('ignored transitions', () => {
  it('reopens an unmuted ignore when the client writes again', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await ignoreItem(admin, Number(item.id), 'not_needed', 'message');
    const ctx = await loadOrgContext();
    await ingestMessage(followUp('<acme-followup-2@acme.com>'), 'priya@cubehq.ai', ctx);
    expect((await itemBySubject('Q3 invoice discrepancy')).state).toBe('needs_reply');
  });

  it('keeps a muted thread ignored however much they write', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await ignoreItem(admin, Number(item.id), 'not_needed', 'thread');
    const ctx = await loadOrgContext();
    await ingestMessage(followUp('<acme-followup-3@acme.com>'), 'priya@cubehq.ai', ctx);
    expect((await itemBySubject('Q3 invoice discrepancy')).state).toBe('ignored');
  });
});

describe('handled elsewhere', () => {
  it('reopens when the client writes again', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await handledElsewhere(admin, Number(item.id), 'called them');
    const ctx = await loadOrgContext();
    await ingestMessage(followUp('<acme-followup-4@acme.com>'), 'priya@cubehq.ai', ctx);
    expect((await itemBySubject('Q3 invoice discrepancy')).state).toBe('needs_reply');
  });
});

describe('sending', () => {
  it('falls back to needs_reply when the send is never confirmed', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await query("UPDATE items SET state='sending', sending_since = now() - interval '6 minutes' WHERE id = $1", [item.id]);
    expect(await sweepStuckSends()).toBe(1);
    const after = await itemBySubject('Q3 invoice discrepancy');
    expect(after.state).toBe('needs_reply');
    expect(after.last_error).toMatch(/not confirmed/);
  });

  it('leaves a recent send alone', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await query("UPDATE items SET state='sending', sending_since = now() WHERE id = $1", [item.id]);
    expect(await sweepStuckSends()).toBe(0);
  });
});

describe('SLA', () => {
  it('sets a due date on items waiting on us, and clears it once replied', async () => {
    const open = await itemBySubject('Q3 invoice discrepancy');
    expect(open.sla_due_at).not.toBeNull();
    const replied = await itemBySubject('Renewal terms');
    expect(replied.state).toBe('replied');
    expect(replied.sla_due_at).toBeNull();
    expect(replied.response_time_seconds).toBeGreaterThan(0);
  });
});

describe('deletion', () => {
  it('archives an item once every copy is gone', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await query(
      `UPDATE message_copies SET deleted = true
         FROM messages m WHERE m.id = message_copies.message_id AND m.conversation_id = $1`,
      [item.conversation_id],
    );
    await tx((c) => recomputeItemState(c, Number(item.conversation_id)));
    expect((await itemBySubject('Q3 invoice discrepancy')).state).toBe('archived');
  });
});
