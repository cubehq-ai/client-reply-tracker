import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../src/db/pool.js';
import { purgeSlackMessages } from '../src/slack/retention.js';
import { setupSchema, teardown } from './helpers.js';

const CH = 'C_RET';
const QUIET = 'C_QUIET';
const CLIENT = 'U_C';
const US = 'U_I';

const DAY = 86_400;
const NOW = Math.floor(Date.now() / 1000);
/** A ts n days ago, which is also the message's id. */
const ago = (days: number): string => String(NOW - days * DAY);

async function seed(
  messages: { ts: string; internal?: boolean; pending?: boolean; threadTs?: string | null }[],
  opts: { watched?: boolean; channel?: string } = {},
): Promise<void> {
  const channel = opts.channel ?? CH;
  await query(
    `INSERT INTO slack_channels (id, name, watched, backfilled_at, last_synced_ts)
     VALUES ($1,$1,$2, now(), '9')
     ON CONFLICT (id) DO UPDATE SET watched = EXCLUDED.watched`,
    [channel, opts.watched ?? true],
  );
  for (const m of messages) {
    await query(
      `INSERT INTO slack_messages (channel_id, ts, thread_ts, user_id, is_internal, text, pending, posted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, to_timestamp($8))`,
      [channel, m.ts, m.threadTs ?? null, m.internal ? US : CLIENT, m.internal ?? false,
        `message ${m.ts}`, m.pending ?? false, Number(m.ts)],
    );
  }
}

const remaining = async (channel = CH): Promise<string[]> => {
  const rows = await query<{ ts: string }>(
    'SELECT ts FROM slack_messages WHERE channel_id = $1 ORDER BY ts::numeric ASC', [channel]);
  return rows.map((r) => r.ts);
};

beforeAll(async () => { await setupSchema(); });
afterAll(async () => { await teardown(); });

beforeEach(async () => {
  await query('TRUNCATE slack_messages, slack_channels RESTART IDENTITY CASCADE');
  await query('TRUNCATE slack_users RESTART IDENTITY CASCADE');
  // Small windows, so a fixture does not have to be a hundred messages long.
  vi.stubEnv('SLACK_RETENTION_DAYS', '30');
  vi.stubEnv('SLACK_KEEP_MESSAGES', '3');
  vi.resetModules();
});

/** The config is read at import, so each case re-imports it under its env. */
const purge = async (): Promise<any> => {
  const mod = await import('../src/slack/retention.js');
  return mod.purgeSlackMessages();
};

describe('slack retention', () => {
  it('deletes answered messages past the window and keeps the recent tail', async () => {
    await seed([
      { ts: ago(90) }, { ts: ago(80), internal: true }, { ts: ago(70) },
      { ts: ago(60), internal: true }, { ts: ago(2) }, { ts: ago(1), internal: true },
    ]);
    const result = await purge();

    // The three newest are kept by SLACK_KEEP_MESSAGES, the rest are old,
    // answered and below the window.
    expect(await remaining()).toEqual([ago(60), ago(2), ago(1)]);
    expect(result.purged).toBe(3);
  });

  it('never deletes a pending message, nor anything after it', async () => {
    await seed([
      { ts: ago(120) }, { ts: ago(110), internal: true },
      { ts: ago(100), pending: true },
      { ts: ago(90) }, { ts: ago(80), internal: true }, { ts: ago(70) }, { ts: ago(60) },
    ]);
    await purge();

    // Everything from the pending message onward survives: reconciliation
    // recomputes pendingness from what it can see, so the tail has to be
    // whole or the answer could change.
    expect(await remaining()).toEqual([ago(100), ago(90), ago(80), ago(70), ago(60)]);
  });

  it('keeps a whole thread while one of its messages is pending', async () => {
    await seed([
      { ts: ago(200) },
      { ts: ago(150), threadTs: ago(150) },
      { ts: ago(149), threadTs: ago(150), pending: true },
      { ts: ago(100) }, { ts: ago(90) }, { ts: ago(80) },
    ]);
    await purge();

    // ago(200) goes; the thread parent stays although it is older than the
    // pending reply, because the question is unreadable without it.
    expect(await remaining()).toContain(ago(150));
    expect(await remaining()).not.toContain(ago(200));
  });

  it('drops every message of a channel that is no longer watched, and rearms its backfill', async () => {
    await seed([{ ts: ago(1) }, { ts: ago(2), pending: true }], { watched: false, channel: QUIET });
    const result = await purge();

    expect(await remaining(QUIET)).toEqual([]);
    expect(result.droppedMessages).toBe(2);
    const ch = await query<any>(
      'SELECT last_synced_ts, backfilled_at, messages_purged FROM slack_channels WHERE id = $1', [QUIET]);
    // Re-watching it in Settings has to backfill, not resume from a
    // watermark whose messages are gone.
    expect(ch[0].last_synced_ts).toBeNull();
    expect(ch[0].backfilled_at).toBeNull();
    expect(ch[0].messages_purged).toBe(2);
  });

  it('records how far it purged, so a view starting mid-conversation can say why', async () => {
    await seed([{ ts: ago(90) }, { ts: ago(85) }, { ts: ago(2) }, { ts: ago(1) }, { ts: ago(0) }]);
    await purge();
    const ch = await query<any>('SELECT purged_through_ts FROM slack_channels WHERE id = $1', [CH]);
    expect(ch[0].purged_through_ts).toBe(ago(85));
  });

  it('is a no-op on a second run', async () => {
    await seed([{ ts: ago(90) }, { ts: ago(85) }, { ts: ago(2) }, { ts: ago(1) }, { ts: ago(0) }]);
    await purge();
    const after = await remaining();
    const again = await purge();
    expect(again.purged).toBe(0);
    expect(await remaining()).toEqual(after);
  });
});

/** Exported for the worker; the suite above drives the re-imported copy. */
void purgeSlackMessages;
