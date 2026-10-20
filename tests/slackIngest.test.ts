import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { FakeSlackClient, emptyWorkspace, msg } from '../src/slack/fake.js';
import { setSlackClient } from '../src/slack/index.js';
import { clearSlackIdentity, syncSlackChannels, syncSlackUsers } from '../src/slack/sync.js';
import { syncOneChannel } from '../src/slack/ingest.js';
import { invalidateOrgContext } from '../src/pipeline/context.js';
import { setupSchema, teardown } from './helpers.js';
import { setLlmClient } from '../src/llm/index.js';
import { FakeLlmClient } from '../src/llm/fake.js';

const CH = 'C_ACME';
const US = 'U_US';
const COLLEAGUE = 'U_MATE';
const CLIENT = 'U_CLIENT';
/** Recent timestamps: anything older than BACKFILL_DAYS is never fetched. */
const BASE = Math.floor(Date.now() / 1000) - 2 * 3600;
const T = (minute: number): string => String(BASE + minute * 60);

let slack: FakeSlackClient;

/** A workspace with one client channel, our two people and the client's one. */
async function workspace(messages: ReturnType<typeof msg>[], opts: { clientEmail?: string } = {}): Promise<void> {
  const ws = emptyWorkspace();
  ws.channels = [{ id: CH, name: 'acme-cube', isPrivate: false, isShared: true, isArchived: false }];
  ws.users = [
    { id: US, teamId: 'T_ORG', email: 'priya@cubehq.ai', name: 'Priya', isBot: false, deleted: false },
    { id: COLLEAGUE, teamId: 'T_ORG', email: 'rahul@cubehq.ai', name: 'Rahul', isBot: false, deleted: false },
    { id: CLIENT, teamId: 'T_ACME', email: opts.clientEmail ?? 'ops@acme.com', name: 'Dana', isBot: false, deleted: false },
  ];
  ws.members.set(CH, [US, COLLEAGUE, CLIENT]);
  ws.messages.set(CH, messages);

  slack = new FakeSlackClient(ws);
  setSlackClient(slack);
  clearSlackIdentity();
  invalidateOrgContext();

  await query('TRUNCATE slack_messages, slack_channels, slack_users RESTART IDENTITY CASCADE');
  await query("DELETE FROM items WHERE source = 'slack'");
  await query("DELETE FROM conversations WHERE global_key LIKE 'slack:%'");
  await query("DELETE FROM classifications WHERE rfc_message_id LIKE 'slack:%'");
  await syncSlackUsers();
  await syncSlackChannels();
}

const run = async (): Promise<void> => {
  const ch = await query<any>('SELECT id, name, last_synced_ts, backfilled_at FROM slack_channels WHERE id = $1', [CH]);
  await syncOneChannel(CH, ch[0].name, ch[0].last_synced_ts, ch[0].backfilled_at != null);
};

const items = async (): Promise<any[]> =>
  query(`SELECT slack_group_ts, state, reason, low_confidence FROM items
          WHERE slack_channel_id = $1 ORDER BY slack_group_ts ASC`, [CH]);

beforeAll(async () => { await setupSchema(); });
afterAll(async () => { setSlackClient(null); await teardown(); });
beforeEach(() => { setLlmClient(new FakeLlmClient()); });

describe('slack reply detection', () => {
  it('a thread reply closes the item', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'Can you check the campaign?' }),
      msg({ ts: T(5), threadTs: T(0), userId: US, text: 'Looking now' }),
    ]);
    await run();
    expect(await items()).toEqual([
      expect.objectContaining({ slack_group_ts: T(0), state: 'no_reply_needed', reason: 'replied' }),
    ]);
  });

  it('a tick from us closes the item', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'Please publish the guide', reactions: { white_check_mark: [US] } }),
    ]);
    await run();
    expect((await items())[0]).toMatchObject({ state: 'no_reply_needed', reason: 'replied' });
  });

  it('a burst of three becomes one item, closed by one reply', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'Hi, quick question' }),
      msg({ ts: T(1), userId: CLIENT, text: 'The report is missing a column' }),
      msg({ ts: T(2), userId: CLIENT, text: 'Can you add it?' }),
      msg({ ts: T(6), userId: US, text: 'Added, take a look' }),
    ]);
    await run();
    const rows = await items();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ slack_group_ts: T(0), state: 'no_reply_needed', reason: 'replied' });
  });

  it('two pending groups and one reply go to the window as low confidence', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'Can you send the invoice?' }),
      msg({ ts: T(30), userId: CLIENT, text: 'Also, when does the campaign start?' }),
      msg({ ts: T(40), userId: US, text: 'Yes on both, today' }),
    ]);
    await run();
    const rows = await items();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.low_confidence)).toBe(true);
  });

  it('an internal message mentioning only a colleague leaves the item open', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'Can you check the campaign?' }),
      msg({ ts: T(5), userId: US, text: `<@${COLLEAGUE}> can you take this one?` }),
    ]);
    await run();
    expect((await items())[0]).toMatchObject({ state: 'needs_reply' });
  });

  it('a client "thanks" needs no reply and closes what came before', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'Can you publish the guide?' }),
      msg({ ts: T(30), userId: CLIENT, text: 'thanks 👍' }),
    ]);
    await run();
    const rows = await items();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ state: 'no_reply_needed', reason: 'not_needed' });
    expect(rows[0]).toMatchObject({ state: 'no_reply_needed' });
  });

  it('bot and join messages are not conversation', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'joined the channel', subtype: 'channel_join' }),
      msg({ ts: T(1), userId: 'B_BOT', text: 'Build passed', isBot: true }),
    ]);
    await run();
    expect(await items()).toHaveLength(0);
  });

  it('a deleted client message closes its item as filtered', async () => {
    await workspace([msg({ ts: T(0), userId: CLIENT, text: 'Can you send the latest invoice please?' })]);
    await run();
    expect((await items())[0]).toMatchObject({ state: 'needs_reply' });
    await query('UPDATE slack_messages SET deleted = true WHERE channel_id = $1', [CH]);
    const { reconcileChannel } = await import('../src/slack/ingest.js');
    await reconcileChannel(CH);
    expect((await items())[0]).toMatchObject({ state: 'no_reply_needed', reason: 'filtered' });
  });
});

describe('channel mapping', () => {
  it('maps a channel to the client its external members belong to', async () => {
    await workspace([msg({ ts: T(0), userId: CLIENT, text: 'hello' })], { clientEmail: 'ops@acme.com' });
    const rows = await query<any>('SELECT client_id, watched, mapping_source FROM slack_channels WHERE id = $1', [CH]);
    expect(rows[0].client_id).not.toBeNull();
    expect(rows[0].watched).toBe(true);
    expect(rows[0].mapping_source).toBe('auto');
  });

  it('leaves a channel unmapped and unwatched when no member matches a client', async () => {
    await workspace([msg({ ts: T(0), userId: CLIENT, text: 'hello' })], { clientEmail: 'someone@unknown-vendor.test' });
    const rows = await query<any>('SELECT client_id, watched FROM slack_channels WHERE id = $1', [CH]);
    expect(rows[0].client_id).toBeNull();
    expect(rows[0].watched).toBe(false);
  });

  it('never overwrites a mapping a person set', async () => {
    await workspace([msg({ ts: T(0), userId: CLIENT, text: 'hello' })], { clientEmail: 'someone@unknown-vendor.test' });
    const client = await query<any>('SELECT id FROM clients LIMIT 1');
    await query(
      `UPDATE slack_channels SET client_id = $2, mapping_source = 'manual', watched = true WHERE id = $1`,
      [CH, client[0].id],
    );
    await syncSlackChannels();
    const rows = await query<any>('SELECT client_id, mapping_source, watched FROM slack_channels WHERE id = $1', [CH]);
    expect(Number(rows[0].client_id)).toBe(Number(client[0].id));
    expect(rows[0].mapping_source).toBe('manual');
    expect(rows[0].watched).toBe(true);
  });
});
