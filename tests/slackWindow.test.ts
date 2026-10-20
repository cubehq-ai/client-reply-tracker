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

/** Answers the window prompt with a fixed partition. */
function modelReturning(answered: string[], unanswered: string[]): LlmClient {
  return {
    classify: async () => ({ needsReply: true, confidence: 0.9, summary: 'q', tier: 'llm' as const }),
    draftReply: async () => JSON.stringify({
      answered_client_message_ids: answered,
      unanswered_client_message_ids: unanswered,
    }),
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

const items = async (): Promise<any[]> =>
  query(`SELECT slack_group_ts, state, reason, low_confidence FROM items
          WHERE slack_channel_id = $1 ORDER BY slack_group_ts ASC`, [CH]);

beforeAll(async () => { await setupSchema(); });
afterAll(async () => { setSlackClient(null); await teardown(); });
beforeEach(async () => { await twoPendingGroups(); });

describe('the llm window', () => {
  it('waits for the channel to go quiet before spending a call', async () => {
    // The newest message is minutes old, so the debounce has not elapsed.
    await query('UPDATE slack_channels SET last_message_at = now() WHERE id = $1', [CH]);
    setLlmClient(modelReturning([T(0), T(30)], []));
    const r = await runSlackWindows(new Date(), true);
    expect(r[0]).toMatchObject({ skipped: 'quiet-pending', decided: 0 });
    expect((await items()).every((i) => i.state === 'needs_reply')).toBe(true);
  });

  it('closes the groups the model says were answered', async () => {
    await query(`UPDATE slack_channels SET last_message_at = now() - interval '30 minutes' WHERE id = $1`, [CH]);
    setLlmClient(modelReturning([T(0), T(30)], []));
    await runSlackWindows(new Date(), true);
    const rows = await items();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.state === 'no_reply_needed' && r.reason === 'replied')).toBe(true);
  });

  it('leaves an unanswered group open, but no longer a guess', async () => {
    await query(`UPDATE slack_channels SET last_message_at = now() - interval '30 minutes' WHERE id = $1`, [CH]);
    setLlmClient(modelReturning([T(0)], [T(30)]));
    await runSlackWindows(new Date(), true);
    const rows = await items();
    expect(rows[0]).toMatchObject({ state: 'no_reply_needed', reason: 'replied' });
    expect(rows[1]).toMatchObject({ state: 'needs_reply', low_confidence: false });
  });

  it('leaves everything alone when the model fails', async () => {
    await query(`UPDATE slack_channels SET last_message_at = now() - interval '30 minutes' WHERE id = $1`, [CH]);
    setLlmClient({
      classify: async () => ({ needsReply: true, confidence: 0.9, summary: '', tier: 'llm' as const }),
      draftReply: async () => { throw new Error('model down'); },
    });
    await runSlackWindows(new Date(), true);
    expect((await items()).every((i) => i.state === 'needs_reply')).toBe(true);
  });
});
