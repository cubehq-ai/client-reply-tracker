import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { getThread } from '../src/api/compose.js';
import { ingestMessage } from '../src/pipeline/ingest.js';
import { loadOrgContext } from '../src/pipeline/context.js';
import { syncAllMailboxes } from '../src/sync/mailboxSync.js';
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

/** An outbound message in the Q3 invoice thread, draft or sent. */
const outbound = (opts: { draft: boolean; body: string; minutesAfter: number }): RawMessage => ({
  id: `out-${Math.random().toString(36).slice(2)}`,
  threadId: 't-acme-1--priya',
  labelIds: opts.draft ? ['DRAFT'] : ['SENT'],
  internalDateMs: Date.now() + opts.minutesAfter * 60_000,
  snippet: '',
  bodyText: opts.body,
  attachments: [],
  headers: {
    from: 'priya@cubehq.ai', to: 'ops@acme.com', subject: 'Re: Q3 invoice discrepancy',
    'message-id': `<out-${Math.random().toString(36).slice(2)}@cubehq.ai>`,
    'in-reply-to': '<acme-1@acme.com>', references: '<acme-1@acme.com>',
  },
});

const bodies = async (itemId: number): Promise<string[]> =>
  (await getThread(admin, itemId)).messages.map((m) => `${m.isDraft ? 'DRAFT:' : 'SENT:'}${m.snippet || m.body}`);

describe('a draft left behind after the reply was sent', () => {
  it('is hidden once a real send follows it', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await ingestMessage(outbound({ draft: true, body: 'Draft nobody cleared', minutesAfter: 1 }), 'priya@cubehq.ai', await loadOrgContext());
    await ingestMessage(outbound({ draft: false, body: 'The real reply', minutesAfter: 2 }), 'priya@cubehq.ai', await loadOrgContext());

    const seen = (await bodies(Number(item.id))).join('|');
    expect(seen).toContain('The real reply');
    expect(seen).not.toContain('Draft nobody cleared');
  });

  it('is kept while no send has followed, because it is unfinished work', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await ingestMessage(outbound({ draft: true, body: 'Still writing this', minutesAfter: 1 }), 'priya@cubehq.ai', await loadOrgContext());

    const seen = (await bodies(Number(item.id))).join('|');
    expect(seen).toContain('Still writing this');
  });

  it('a draft written after the send survives: it is a new reply, not a leftover', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await ingestMessage(outbound({ draft: false, body: 'First reply', minutesAfter: 1 }), 'priya@cubehq.ai', await loadOrgContext());
    await ingestMessage(outbound({ draft: true, body: 'Following up separately', minutesAfter: 5 }), 'priya@cubehq.ai', await loadOrgContext());

    const seen = (await bodies(Number(item.id))).join('|');
    expect(seen).toContain('Following up separately');
  });
});
