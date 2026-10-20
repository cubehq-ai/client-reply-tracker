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

/** The one item for the channel. */
const item = async (): Promise<any> => {
  const rows = await query<any>(
    `SELECT state, reason, low_confidence, pending_count, preview, oldest_pending_ts
       FROM items WHERE slack_channel_id = $1`, [CH]);
  return rows[0] ?? null;
};

beforeAll(async () => { await setupSchema(); });
afterAll(async () => { setSlackClient(null); await teardown(); });
beforeEach(() => { setLlmClient(new FakeLlmClient()); });

describe('a channel is the unit of work', () => {
  it('one unanswered question leaves the channel needing a reply', async () => {
    await workspace([msg({ ts: T(0), userId: CLIENT, text: 'Can you check the campaign?' })]);
    await run();
    expect(await item()).toMatchObject({ state: 'needs_reply', pending_count: 1 });
  });

  it('two channels produce two items, not one per message', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'Can you check the campaign?' }),
      msg({ ts: T(30), userId: CLIENT, text: 'And the invoice is wrong' }),
      msg({ ts: T(60), userId: CLIENT, text: 'Also our report is missing a column' }),
    ]);
    await run();
    const rows = await query<any>(`SELECT id FROM items WHERE slack_channel_id = $1`, [CH]);
    expect(rows).toHaveLength(1);
    expect(await item()).toMatchObject({ state: 'needs_reply', pending_count: 3 });
  });

  it('a thread reply moves the channel to answered', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'Can you check the campaign?' }),
      msg({ ts: T(5), threadTs: T(0), userId: US, text: 'Looking now' }),
    ]);
    await run();
    expect(await item()).toMatchObject({ state: 'no_reply_needed', reason: 'replied', pending_count: 0 });
  });

  it('a tick moves the channel to answered', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'Please publish the guide', reactions: { white_check_mark: [US] } }),
    ]);
    await run();
    expect(await item()).toMatchObject({ state: 'no_reply_needed', reason: 'replied' });
  });

  it('a top-level reply moves the channel to answered', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'Can you check the campaign?' }),
      msg({ ts: T(5), userId: US, text: 'Done, have a look' }),
    ]);
    await run();
    expect(await item()).toMatchObject({ state: 'no_reply_needed', reason: 'replied' });
  });

  it('a question in a thread keeps the channel open even when the channel itself moved on', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'Here is the brief' }),
      msg({ ts: T(2), threadTs: T(0), userId: CLIENT, text: 'Could you confirm the budget on this?' }),
      msg({ ts: T(10), userId: US, text: 'Unrelated: the report is live' }),
    ]);
    await run();
    const row = await item();
    expect(row).toMatchObject({ state: 'needs_reply' });
    expect(row.oldest_pending_ts).toBe(T(2));
  });

  it('a client "thanks" after our reply closes it as not needed', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'Can you publish the guide?' }),
      msg({ ts: T(5), userId: US, text: 'Published' }),
      msg({ ts: T(10), userId: CLIENT, text: 'thanks 👍' }),
    ]);
    await run();
    expect(await item()).toMatchObject({ state: 'no_reply_needed', reason: 'not_needed', pending_count: 0 });
  });

  it('chatter that only @mentions a colleague leaves the channel open', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'Can you check the campaign?' }),
      msg({ ts: T(5), userId: US, text: `<@${COLLEAGUE}> can you take this one?` }),
    ]);
    await run();
    expect(await item()).toMatchObject({ state: 'needs_reply', pending_count: 1 });
  });

  it('previews the oldest thing still waiting', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'First: the invoice is wrong' }),
      msg({ ts: T(30), userId: CLIENT, text: 'Second: the report is late' }),
    ]);
    await run();
    const row = await item();
    expect(row.preview).toContain('First');
    expect(row.oldest_pending_ts).toBe(T(0));
  });

  it('bot and join messages are not conversation', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'joined the channel', subtype: 'channel_join' }),
      msg({ ts: T(1), userId: 'B_BOT', text: 'Build passed', isBot: true }),
    ]);
    await run();
    expect(await item()).toMatchObject({ pending_count: 0 });
  });
});

describe('marking answered by hand', () => {
  const admin = { id: 0, email: 'dev@cubehq.ai', name: 'Dev', role: 'admin' as const, canSendAsShared: true };

  it('marking the channel read closes it and writes an audit row', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'Can you check the campaign?' }),
      msg({ ts: T(30), userId: CLIENT, text: 'And the invoice?' }),
    ]);
    await run();
    const { markSlackAnswered } = await import('../src/api/slackApi.js');
    const id = (await query<any>('SELECT id FROM items WHERE slack_channel_id = $1', [CH]))[0].id;
    const r = await markSlackAnswered(admin, Number(id), null);

    expect(r.cleared).toBe(2);
    expect(await item()).toMatchObject({ state: 'no_reply_needed', pending_count: 0 });
    const audit = await query<any>(
      `SELECT action FROM audit_log WHERE item_id = $1 ORDER BY id DESC LIMIT 1`, [id]);
    expect(audit[0].action).toBe('slack_mark_channel_read');
  });

  it('marking one message answered leaves the others waiting', async () => {
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: 'Can you check the campaign?' }),
      msg({ ts: T(30), userId: CLIENT, text: 'And the invoice?' }),
    ]);
    await run();
    const { markSlackAnswered } = await import('../src/api/slackApi.js');
    const id = (await query<any>('SELECT id FROM items WHERE slack_channel_id = $1', [CH]))[0].id;
    await markSlackAnswered(admin, Number(id), T(0));

    const row = await item();
    expect(row).toMatchObject({ state: 'needs_reply', pending_count: 1 });
    expect(row.oldest_pending_ts).toBe(T(30));
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

describe('ownership', () => {
  it('names the internal person the client addressed, account or not', async () => {
    await query(`DELETE FROM users WHERE email = 'priya@cubehq.ai'`);
    await workspace([
      msg({ ts: T(0), userId: CLIENT, text: `Hi <@${US}>, could you send the report?` }),
    ]);
    await run();
    const rows = await query<any>(
      `SELECT su.name, i.owner_user_id FROM items i JOIN slack_users su ON su.id = i.slack_owner_id
        WHERE i.slack_channel_id = $1`, [CH]);
    expect(rows[0]?.name).toBe('Priya');
    expect(rows[0]?.owner_user_id).toBeNull();
  });

  it('falls back to whoever from our side last spoke in the channel', async () => {
    await workspace([
      msg({ ts: T(0), userId: US, text: 'morning all' }),
      msg({ ts: T(30), userId: CLIENT, text: 'Could you send the report over?' }),
    ]);
    await run();
    const rows = await query<any>(
      `SELECT su.name FROM items i JOIN slack_users su ON su.id = i.slack_owner_id
        WHERE i.slack_channel_id = $1`, [CH]);
    expect(rows[0]?.name).toBe('Priya');
  });
});

describe('a manual mark outlasts the next sync', () => {
  const admin = { id: 0, email: 'dev@cubehq.ai', name: 'Dev', role: 'admin' as const, canSendAsShared: true };

  it('does not reopen a message a person marked answered', async () => {
    // Reconciliation recomputes pending from the rules every pass, and the
    // rules cannot know a human looked at it.
    await workspace([msg({ ts: T(0), userId: CLIENT, text: 'Can you check the campaign?' })]);
    await run();
    const { markSlackAnswered } = await import('../src/api/slackApi.js');
    const id = (await query<any>('SELECT id FROM items WHERE slack_channel_id = $1', [CH]))[0].id;
    await markSlackAnswered(admin, Number(id), T(0));
    expect(await item()).toMatchObject({ state: 'no_reply_needed', pending_count: 0 });

    const { reconcileChannel } = await import('../src/slack/ingest.js');
    await reconcileChannel(CH);

    expect(await item()).toMatchObject({ state: 'no_reply_needed', pending_count: 0 });
    const row = await query<any>('SELECT pending, answered_by FROM slack_messages WHERE channel_id = $1 AND ts = $2', [CH, T(0)]);
    expect(row[0].pending).toBe(false);
    expect(row[0].answered_by).toBe('dev@cubehq.ai');
  });

  it('still opens a genuinely new client message in that channel', async () => {
    await workspace([msg({ ts: T(0), userId: CLIENT, text: 'Can you check the campaign?' })]);
    await run();
    const { markSlackAnswered } = await import('../src/api/slackApi.js');
    const id = (await query<any>('SELECT id FROM items WHERE slack_channel_id = $1', [CH]))[0].id;
    await markSlackAnswered(admin, Number(id), T(0));

    slack.workspace.messages.get(CH)!.push(msg({ ts: T(90), userId: CLIENT, text: 'Any update on the invoice?' }));
    await run();
    expect(await item()).toMatchObject({ state: 'needs_reply', pending_count: 1, oldest_pending_ts: T(90) });
  });
});
