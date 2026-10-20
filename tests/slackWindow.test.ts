import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { FakeSlackClient, emptyWorkspace, msg } from '../src/slack/fake.js';
import { setSlackClient } from '../src/slack/index.js';
import { clearSlackIdentity, syncSlackChannels, syncSlackUsers } from '../src/slack/sync.js';
import { syncOneChannel } from '../src/slack/ingest.js';
import { runSlackWindows } from '../src/slack/window.js';
import { invalidateOrgContext } from '../src/pipeline/context.js';
import { setLlmClient } from '../src/llm/index.js';
import type { LlmClient } from '../src/llm/types.js';
import { setupSchema, teardown } from './helpers.js';

const CH = 'C_WIN';
const US = 'U_US';
const CLIENT = 'U_CLIENT';
const BASE = Math.floor(Date.now() / 1000) - 4 * 3600;
const T = (minute: number): string => String(BASE + minute * 60);

/** Answers the window prompt with a fixed list of still-unanswered ids. */
function modelReturning(unanswered: string[]): LlmClient {
  return {
    classify: async () => ({ needsReply: true, confidence: 0.9, summary: 'q', tier: 'llm' as const }),
    draftReply: async () => JSON.stringify({ unanswered_client_message_ids: unanswered }),
  };
}

async function twoPendingGroups(): Promise<void> {
  const ws = emptyWorkspace();
  ws.channels = [{ id: CH, name: 'acme-cube', isPrivate: false, isShared: true, isArchived: false }];
  ws.users = [
    { id: US, teamId: 'T_ORG', email: 'priya@cubehq.ai', name: 'Priya', isBot: false, deleted: false },
    { id: CLIENT, teamId: 'T_ACME', email: 'ops@acme.com', name: 'Dana', isBot: false, deleted: false },
  ];
  ws.members.set(CH, [US, CLIENT]);
  ws.messages.set(CH, [
    msg({ ts: T(0), userId: CLIENT, text: 'Can you send the invoice?' }),
    msg({ ts: T(30), userId: CLIENT, text: 'And when does the campaign start?' }),
    msg({ ts: T(40), userId: US, text: 'Invoice is out; campaign starts Monday' }),
  ]);

  setSlackClient(new FakeSlackClient(ws));
  clearSlackIdentity();
  invalidateOrgContext();
  await query('TRUNCATE slack_messages, slack_channels, slack_users RESTART IDENTITY CASCADE');
  await query("DELETE FROM items WHERE source = 'slack'");
  await query("DELETE FROM conversations WHERE global_key LIKE 'slack:%'");
  await query("DELETE FROM classifications WHERE rfc_message_id LIKE 'slack:%'");
  await syncSlackUsers();
  await syncSlackChannels();
  const ch = await query<any>('SELECT name FROM slack_channels WHERE id = $1', [CH]);
  await syncOneChannel(CH, ch[0].name, null, false);
}

const item = async (): Promise<any> =>
  (await query<any>(
    `SELECT state, reason, low_confidence, pending_count, oldest_pending_ts
       FROM items WHERE slack_channel_id = $1`, [CH]))[0];

const pending = async (): Promise<string[]> =>
  (await query<{ ts: string }>(
    'SELECT ts FROM slack_messages WHERE channel_id = $1 AND pending ORDER BY ts', [CH])).map((r) => r.ts);

beforeAll(async () => { await setupSchema(); });
afterAll(async () => { setSlackClient(null); await teardown(); });
beforeEach(async () => { await twoPendingGroups(); });

describe('the llm window', () => {
  it('waits for the channel to go quiet before spending a call', async () => {
    await query('UPDATE slack_channels SET last_message_at = now() WHERE id = $1', [CH]);
    setLlmClient(modelReturning([T(0), T(30)]));
    const r = await runSlackWindows(new Date(), true);
    expect(r[0]).toMatchObject({ skipped: 'quiet-pending', decided: 0 });
  });

  it('reopens the questions the model says were never answered', async () => {
    // One reply was credited with answering both; the model says only the
    // first was.
    await query(`UPDATE slack_channels SET last_message_at = now() - interval '30 minutes' WHERE id = $1`, [CH]);
    setLlmClient(modelReturning([T(30)]));
    await runSlackWindows(new Date(), true);

    expect(await pending()).toEqual([T(30)]);
    expect(await item()).toMatchObject({ state: 'needs_reply', pending_count: 1, oldest_pending_ts: T(30) });
  });

  it('leaves the channel answered when the model agrees both were', async () => {
    await query(`UPDATE slack_channels SET last_message_at = now() - interval '30 minutes' WHERE id = $1`, [CH]);
    setLlmClient(modelReturning([]));
    await runSlackWindows(new Date(), true);
    expect(await pending()).toEqual([]);
    expect(await item()).toMatchObject({ state: 'no_reply_needed' });
  });

  it('will not reopen something a fact closed', async () => {
    // The model is only allowed to overturn rule 3's guess. A tick or a
    // thread reply is not its to argue with.
    await query('UPDATE slack_messages SET reactions = $2::jsonb WHERE channel_id = $1 AND ts = $3',
      [CH, JSON.stringify({ white_check_mark: [US] }), T(0)]);
    await query(`UPDATE slack_channels SET last_message_at = now() - interval '30 minutes' WHERE id = $1`, [CH]);
    setLlmClient(modelReturning([T(0), T(30)]));
    await runSlackWindows(new Date(), true);
    expect(await pending()).not.toContain(T(0));
  });

  it('without a model, keeps the guess but says it is one', async () => {
    await query(`UPDATE slack_channels SET last_message_at = now() - interval '30 minutes' WHERE id = $1`, [CH]);
    await runSlackWindows(new Date(), false);
    expect(await item()).toMatchObject({ state: 'no_reply_needed', low_confidence: true });
  });

  it('leaves everything alone when the model fails', async () => {
    await query(`UPDATE slack_channels SET last_message_at = now() - interval '30 minutes' WHERE id = $1`, [CH]);
    setLlmClient({
      classify: async () => ({ needsReply: true, confidence: 0.9, summary: '', tier: 'llm' as const }),
      draftReply: async () => { throw new Error('model down'); },
    });
    await runSlackWindows(new Date(), true);
    expect(await pending()).toEqual([]);
  });
});
