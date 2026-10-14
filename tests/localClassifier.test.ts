import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { heuristicClassify } from '../src/pipeline/classify.js';
import { localClassify, modelStatus, tokenize, trainLocalClassifier } from '../src/llm/localClassifier.js';
import { syncAllMailboxes } from '../src/sync/mailboxSync.js';
import { freshHarness, setupSchema, teardown } from './helpers.js';

beforeAll(async () => { await setupSchema(); });
afterAll(async () => { await teardown(); });
beforeEach(async () => { await freshHarness(); });

describe('tier A heuristics', () => {
  it('closes a bare acknowledgement without paying for a model', () => {
    expect(heuristicClassify({ subject: 'Re: x', body: 'Thanks!' })).toMatchObject({ needsReply: false, confidence: 0.9, tier: 'heuristic' });
    expect(heuristicClassify({ subject: 'Re: x', body: 'Got it, thank you' })?.needsReply).toBe(false);
  });

  it('refuses when the message still asks for something', () => {
    expect(heuristicClassify({ subject: 'Re: x', body: 'Thanks, please send the invoice' })).toBeNull();
    expect(heuristicClassify({ subject: 'Re: x', body: 'Got it. Can you confirm the date' })).toBeNull();
    expect(heuristicClassify({ subject: 'Re: x', body: 'Noted, when will it ship' })).toBeNull();
  });

  it('refuses to decide when there is a question', () => {
    expect(heuristicClassify({ subject: 'Re: x', body: 'Thanks! Can you also send the invoice?' })).toBeNull();
  });

  it('refuses to decide on anything 200 characters or longer', () => {
    expect(heuristicClassify({ subject: 'Re: x', body: `Thanks. ${'x'.repeat(200)}` })).toBeNull();
  });
});

describe('tokenizer', () => {
  it('drops stop words and punctuation but keeps question marks out of tokens', () => {
    expect(tokenize('Can you please confirm the invoice?')).toEqual(['please', 'confirm', 'invoice?']);
  });
});

describe('local model', () => {
  it('reports untrained before there is data', async () => {
    expect(await modelStatus()).toMatchObject({ trained: false });
  });

  it('refuses to train on too few examples', async () => {
    await syncAllMailboxes();
    const res = await trainLocalClassifier();
    expect(res.trained).toBe(false);
    expect(res.reason).toMatch(/at least/);
  });

  it('trains once there is enough labelled history and then answers confidently', async () => {
    await syncAllMailboxes();

    // Synthesise labelled history: replied items mean "needed a reply",
    // ignored-as-not-needed means it did not.
    const conv = await query<{ id: string }>('SELECT id FROM conversations LIMIT 1');
    const conversationId = Number(conv[0]!.id);
    for (let i = 0; i < 60; i++) {
      const needs = i % 2 === 0;
      const body = needs
        ? 'Could you please confirm the delivery schedule? We are blocked and need an answer.'
        : 'Thanks for sorting that out, nothing further needed from your side.';
      const itemRes = await query<{ id: string }>(
        `INSERT INTO items (conversation_id, state, reason, replied_at)
         VALUES ($1, 'no_reply_needed', $2, $3) ON CONFLICT (conversation_id) DO NOTHING RETURNING id`,
        [conversationId, needs ? 'replied' : 'not_needed', needs ? new Date() : null],
      );
      void itemRes;
      await query(
        `INSERT INTO messages (conversation_id, rfc_message_id, from_email, from_domain, subject,
                               internal_date, direction, body_text_trunc)
         VALUES ($1,$2,'ops@acme.com','acme.com','Training sample', now(), 'in', $3)
         ON CONFLICT (rfc_message_id) DO NOTHING`,
        [conversationId, `<train-${i}@acme.com>`, body],
      );
    }

    // The training query reads one item per conversation, so build the label
    // set directly instead: many conversations, one item each.
    for (let i = 0; i < 60; i++) {
      const needs = i % 2 === 0;
      const c = await query<{ id: string }>(
        `INSERT INTO conversations (global_key, subject) VALUES ($1,'Training sample') RETURNING id`,
        [`<train-conv-${i}@acme.com>`],
      );
      const cid = Number(c[0]!.id);
      await query(
        `INSERT INTO messages (conversation_id, rfc_message_id, from_email, from_domain, subject,
                               internal_date, direction, body_text_trunc)
         VALUES ($1,$2,'ops@acme.com','acme.com','Training sample', now(), 'in', $3)`,
        [cid, `<train-msg-${i}@acme.com>`, needs
          ? 'Could you please confirm the delivery schedule? We are blocked and need an answer today.'
          : 'Thanks for sorting that out, nothing further needed from your side.'],
      );
      await query(
        `INSERT INTO items (conversation_id, state, reason, replied_at)
         VALUES ($1, 'no_reply_needed', $2, $3)`,
        [cid, needs ? 'replied' : 'not_needed', needs ? new Date() : null],
      );
    }

    const res = await trainLocalClassifier();
    expect(res.trained).toBe(true);
    expect((await modelStatus()).trained).toBe(true);

    const verdict = await localClassify({
      subject: 'Delivery',
      body: 'Could you please confirm the delivery schedule? We are blocked and need an answer today.',
    });
    expect(verdict?.needsReply).toBe(true);
    expect(verdict?.model).toBe('local-nb-v1');
  });
});
