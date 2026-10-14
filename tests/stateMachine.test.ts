import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query, tx } from '../src/db/pool.js';
import { recomputeItemState } from '../src/pipeline/stateMachine.js';
import { loadOrgContext } from '../src/pipeline/context.js';
import { ingestMessage } from '../src/pipeline/ingest.js';
import { syncAllMailboxes } from '../src/sync/mailboxSync.js';
import { ignoreItem, markNeedsReply, markNoReplyNeeded } from '../src/api/actions.js';
import type { SessionUser } from '../src/api/auth.js';
import type { RawMessage } from '../src/gmail/types.js';
import { freshHarness, itemBySubject, setupSchema, teardown } from './helpers.js';

const admin: SessionUser = { id: 0, email: 'dev@cubehq.ai', name: 'Dev', role: 'admin', canSendAsShared: true };

beforeAll(async () => { await setupSchema(); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await freshHarness();
  await syncAllMailboxes();
  const row = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [admin.email]);
  admin.id = Number(row[0]!.id);
});

const followUp = (messageId: string, body = 'Any update on this? We are blocked.'): RawMessage => ({
  id: `ext-${Math.random().toString(36).slice(2)}`,
  threadId: 't-acme-1--priya',
  labelIds: ['INBOX'],
  internalDateMs: Date.now(),
  snippet: '',
  bodyText: body,
  attachments: [],
  headers: {
    from: 'ops@acme.com', to: 'priya@cubehq.ai', subject: 'Re: Q3 invoice discrepancy',
    'message-id': messageId, 'in-reply-to': '<acme-1@acme.com>', references: '<acme-1@acme.com>',
  },
});

describe('two states only', () => {
  it('never produces a state outside the pair', async () => {
    const states = await query<{ state: string }>('SELECT DISTINCT state FROM items');
    expect(states.map((s) => s.state).sort()).toEqual(expect.arrayContaining([]));
    for (const s of states) expect(['needs_reply', 'no_reply_needed']).toContain(s.state);
  });

  it('every closed item records why', async () => {
    const bad = await query("SELECT count(*)::int AS n FROM items WHERE state = 'no_reply_needed' AND reason IS NULL");
    expect(Number((bad[0] as any).n)).toBe(0);
  });
});

describe('reply detection closes an item', () => {
  it('an internal reply to the client sets reason replied', async () => {
    const item = await itemBySubject('Renewal terms');
    expect(item.state).toBe('no_reply_needed');
    expect(item.reason).toBe('replied');
    expect(item.response_time_seconds).toBeGreaterThan(0);
  });
});

describe('classifier outcomes', () => {
  it('a client "Thanks!" closes as not_needed', async () => {
    const item = await itemBySubject('Shipping address update');
    expect(item.state).toBe('no_reply_needed');
    expect(item.reason).toBe('not_needed');
  });

  it('a client question after our reply reopens', async () => {
    const item = await itemBySubject('Onboarding checklist');
    expect(item.state).toBe('needs_reply');
    expect(item.reopen_count).toBe(1);
  });
});

describe('triage outcomes reach the item', () => {
  it('a newsletter is closed as filtered', async () => {
    expect(await itemBySubject('Last chance: 40% off analytics seats')).toMatchObject({
      state: 'no_reply_needed', reason: 'filtered',
    });
  });

  it('cold outreach is closed as filtered', async () => {
    expect(await itemBySubject('Quick question about your SEO stack')).toMatchObject({
      state: 'no_reply_needed', reason: 'filtered', filter_reason: 'no_prior_contact',
    });
  });

  it('a known contact who is not a client needs a reply, flagged unmatched', async () => {
    const item = await itemBySubject('Taking over the account');
    expect(item.state).toBe('needs_reply');
    expect(item.unmatched_client).toBe(true);
  });

  it('client mail in Updates survives', async () => {
    expect((await itemBySubject('Integration timeline?')).state).toBe('needs_reply');
  });
});

describe('ignore and mute', () => {
  it('ignore closes the item with reason ignored', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await ignoreItem(admin, Number(item.id), 'not_needed', 'message');
    expect(await itemBySubject('Q3 invoice discrepancy')).toMatchObject({ state: 'no_reply_needed', reason: 'ignored' });
  });

  it('an unmuted ignore reopens when the client writes again', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await ignoreItem(admin, Number(item.id), 'not_needed', 'message');
    const ctx = await loadOrgContext();
    await ingestMessage(followUp('<acme-f1@acme.com>'), 'priya@cubehq.ai', ctx);
    expect((await itemBySubject('Q3 invoice discrepancy')).state).toBe('needs_reply');
  });

  it('a muted thread stays closed however much they write', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await ignoreItem(admin, Number(item.id), 'not_needed', 'thread');
    const ctx = await loadOrgContext();
    await ingestMessage(followUp('<acme-f2@acme.com>'), 'priya@cubehq.ai', ctx);
    expect((await itemBySubject('Q3 invoice discrepancy')).state).toBe('no_reply_needed');
  });
});

describe('user overrides', () => {
  it('"Needs reply" reopens a closed item and logs feedback', async () => {
    const item = await itemBySubject('Shipping address update');
    await markNeedsReply(admin, Number(item.id));
    expect((await itemBySubject('Shipping address update')).state).toBe('needs_reply');
    expect((await query('SELECT * FROM classifier_feedback')).length).toBe(1);
  });

  it('"No reply needed" closes an open item and logs feedback', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await markNoReplyNeeded(admin, Number(item.id));
    expect(await itemBySubject('Q3 invoice discrepancy')).toMatchObject({ state: 'no_reply_needed', reason: 'not_needed' });
    expect((await query('SELECT * FROM classifier_feedback')).length).toBe(1);
  });

  it('"Needs reply" un-mutes, so the thread can reopen again', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await ignoreItem(admin, Number(item.id), 'not_needed', 'thread');
    await markNeedsReply(admin, Number(item.id));
    expect((await itemBySubject('Q3 invoice discrepancy')).muted).toBe(false);
  });
});

describe('deletion', () => {
  it('closes an item once every copy is gone', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await query(
      `UPDATE message_copies SET deleted = true
         FROM messages m WHERE m.id = message_copies.message_id AND m.conversation_id = $1`,
      [item.conversation_id],
    );
    await tx((c) => recomputeItemState(c, Number(item.conversation_id)));
    expect(await itemBySubject('Q3 invoice discrepancy')).toMatchObject({
      state: 'no_reply_needed', reason: 'filtered',
    });
  });
});
