import { query, tx } from '../db/pool.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { classifyMessage } from '../pipeline/classify.js';
import { getSlackClient, slackConfigured } from './index.js';
import { isAcknowledgement, type StoredSlackMessage } from './groups.js';
import { ambiguousClosures, computePending } from './pending.js';
import { ensureSlackUsers, slackIdentity } from './sync.js';
import type { SlackMessage } from './types.js';

/** Slack ts values are seconds with microseconds; compare numerically. */
const tsToDate = (ts: string): Date => new Date(Number(ts) * 1000);

/** channel_join, topic changes and the like are not conversation. */
function isConversational(m: SlackMessage): boolean {
  if (m.isBot) return false;
  if (m.userId == null) return false;
  if (m.subtype && m.subtype !== 'thread_broadcast' && m.subtype !== 'me_message') return false;
  return true;
}

export interface ChannelSyncStats {
  channel: string;
  fetched: number;
  stored: number;
  items: number;
}

/**
 * Pulls new messages for every watched channel and recomputes its items.
 *
 * Only watched channels: an unmapped channel is not a client's, and reading
 * it would both cost calls and file someone else's conversation as work.
 */
export async function syncSlackChannelMessages(): Promise<ChannelSyncStats[]> {
  if (!slackConfigured()) return [];

  const channels = await query<{ id: string; name: string; last_synced_ts: string | null; backfilled_at: Date | null }>(
    'SELECT id, name, last_synced_ts, backfilled_at FROM slack_channels WHERE watched AND NOT is_archived',
  );

  const stats: ChannelSyncStats[] = [];
  for (const ch of channels) {
    try {
      stats.push(await syncOneChannel(ch.id, ch.name, ch.last_synced_ts, ch.backfilled_at != null));
    } catch (err) {
      logger.error({ channel: ch.name, err }, 'slack channel sync failed');
    }
  }
  return stats;
}

export async function syncOneChannel(
  channelId: string,
  channelName: string,
  lastSyncedTs: string | null,
  backfilled: boolean,
): Promise<ChannelSyncStats> {
  const client = getSlackClient();

  // First pass reads the backfill window; later passes read only what is new.
  const oldest = lastSyncedTs
    ?? (backfilled ? null : String((Date.now() - config.org.backfillDays * 86_400_000) / 1000));

  const top: SlackMessage[] = [];
  let cursor: string | null = null;
  do {
    const page = await client.history(channelId, { oldest, cursor });
    top.push(...page.items);
    cursor = page.cursor;
  } while (cursor);

  // A thread can gain replies long after its parent, and history() does not
  // report them, so any thread touched here is re-read in full.
  const threadTs = new Set<string>();
  for (const m of top) {
    if (m.replyCount > 0) threadTs.add(m.threadTs ?? m.ts);
    if (m.threadTs) threadTs.add(m.threadTs);
  }
  const knownThreads = await query<{ thread_ts: string }>(
    `SELECT DISTINCT thread_ts FROM slack_messages
      WHERE channel_id = $1 AND thread_ts IS NOT NULL
        AND ($2::text IS NULL OR thread_ts >= $2)`,
    [channelId, lastSyncedTs],
  );
  for (const r of knownThreads) threadTs.add(r.thread_ts);

  const all: SlackMessage[] = [...top];
  for (const t of threadTs) {
    let c: string | null = null;
    do {
      const page = await client.replies(channelId, t, c);
      all.push(...page.items);
      c = page.cursor;
    } while (c);
  }

  const stored = await storeMessages(channelId, all);
  const items = await reconcileChannel(channelId);

  const newest = all.reduce<string | null>((max, m) => (max == null || Number(m.ts) > Number(max) ? m.ts : max), null);
  if (newest) {
    await query(
      `UPDATE slack_channels
          SET last_synced_ts = $2, last_message_at = $3, backfilled_at = COALESCE(backfilled_at, now()), updated_at = now()
        WHERE id = $1`,
      [channelId, newest, tsToDate(newest)],
    );
  } else if (!backfilled) {
    await query('UPDATE slack_channels SET backfilled_at = now(), updated_at = now() WHERE id = $1', [channelId]);
  }

  return { channel: channelName, fetched: all.length, stored, items };
}

/** Upserts messages, carrying edits and reactions through. */
async function storeMessages(channelId: string, messages: SlackMessage[]): Promise<number> {
  // An author from the client's workspace is not in users.list, and without
  // their row every message of theirs would be filed as internal.
  await ensureSlackUsers([...new Set(messages.map((m) => m.userId).filter((id): id is string => id != null))]);
  const internal = await internalUserIds();
  let stored = 0;

  for (const m of messages) {
    if (!isConversational(m)) continue;
    await query(
      `INSERT INTO slack_messages (channel_id, ts, thread_ts, user_id, is_internal, text, reactions, edited, posted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)
       ON CONFLICT (channel_id, ts) DO UPDATE SET
         text = EXCLUDED.text, reactions = EXCLUDED.reactions, edited = EXCLUDED.edited,
         thread_ts = EXCLUDED.thread_ts`,
      [
        channelId, m.ts, m.threadTs, m.userId,
        m.userId != null && internal.has(m.userId),
        m.text, JSON.stringify(m.reactions), m.edited, tsToDate(m.ts),
      ],
    );
    stored += 1;
  }
  return stored;
}

async function internalUserIds(): Promise<Set<string>> {
  const rows = await query<{ id: string }>('SELECT id FROM slack_users WHERE is_internal');
  return new Set(rows.map((r) => r.id));
}

async function loadChannelMessages(channelId: string): Promise<StoredSlackMessage[]> {
  const rows = await query<any>(
    `SELECT ts, thread_ts, user_id, is_internal, text, reactions, deleted, posted_at
       FROM slack_messages WHERE channel_id = $1 ORDER BY ts ASC`,
    [channelId],
  );
  return rows.map((r) => ({
    ts: r.ts,
    threadTs: r.thread_ts,
    userId: r.user_id,
    isInternal: r.is_internal,
    text: r.text,
    reactions: r.reactions ?? {},
    deleted: r.deleted,
    postedAt: new Date(r.posted_at),
  }));
}

/**
 * Recomputes a channel's item from its stored messages.
 *
 * One item per channel: "who is waiting on us in #acme-cube" is the question
 * people actually ask, and a row per message group answered half of it each
 * time. Pendingness lives on the message; the item aggregates it.
 */
export async function reconcileChannel(channelId: string): Promise<number> {
  const ch = await query<{ name: string; client_id: string | null }>(
    'SELECT name, client_id FROM slack_channels WHERE id = $1',
    [channelId],
  );
  if (!ch[0]) return 0;

  const messages = await loadChannelMessages(channelId);
  const internal = await internalUserIds();
  const result = computePending(messages, internal);

  // Persist pendingness per message, so the conversation view can mark the
  // individual ones and a later pass can reopen exactly what the model says.
  const pendingTs = result.verdicts.filter((v) => v.pending).map((v) => v.ts);
  const settledTs = result.verdicts.filter((v) => !v.pending).map((v) => v.ts);
  if (pendingTs.length > 0) {
    // answered_at is the one thing the rules defer to: somebody looked at
    // this and said it was handled, and a pass minutes later must not argue.
    await query(
      `UPDATE slack_messages SET pending = true
        WHERE channel_id = $1 AND ts = ANY($2::text[]) AND answered_at IS NULL`,
      [channelId, pendingTs],
    );
  }
  if (settledTs.length > 0) {
    await query(
      'UPDATE slack_messages SET pending = false WHERE channel_id = $1 AND ts = ANY($2::text[])',
      [channelId, settledTs],
    );
  }

  // One internal message credited with answering several questions is the
  // case the model is asked about, once the channel goes quiet.
  const ambiguous = ambiguousClosures(result).length > 0;

  await writeChannelItem(channelId, ch[0].name, ch[0].client_id == null ? null : Number(ch[0].client_id), ambiguous);
  return 1;
}

/** Everything the row needs, computed from the messages rather than guessed. */
export async function writeChannelItem(
  channelId: string,
  channelName: string,
  clientId: number | null,
  lowConfidence: boolean,
): Promise<void> {
  const stats = await query<any>(
    `SELECT
       count(*) FILTER (WHERE pending) AS pending_count,
       min(posted_at) FILTER (WHERE pending) AS oldest_pending_at,
       min(ts) FILTER (WHERE pending) AS oldest_pending_ts,
       max(posted_at) FILTER (WHERE NOT is_internal) AS last_client_at,
       max(posted_at) FILTER (WHERE is_internal) AS last_internal_at,
       max(posted_at) AS last_activity
     FROM slack_messages WHERE channel_id = $1 AND NOT deleted`,
    [channelId],
  );
  const s = stats[0] ?? {};
  const pendingCount = Number(s.pending_count ?? 0);

  const previewRow = await query<{ text: string }>(
    `SELECT text FROM slack_messages
      WHERE channel_id = $1 AND pending AND NOT deleted ORDER BY ts ASC LIMIT 1`,
    [channelId],
  );
  const preview = previewRow[0]?.text?.slice(0, 200) ?? null;

  // A channel with nothing pending is answered. "not_needed" is the honest
  // reason when the last thing the client said asked nothing of us.
  const state = pendingCount > 0 ? 'needs_reply' : 'no_reply_needed';
  const reason = pendingCount > 0 ? null : await closedReason(channelId);

  const owner = await ownerForChannel(channelId, preview ?? '');

  await tx(async (c) => {
    const globalKey = `slack:${channelId}`;
    const conv = await c.query<{ id: string }>(
      `INSERT INTO conversations (global_key, subject, client_id, first_external_at, last_external_at, updated_at)
       VALUES ($1,$2,$3,$4,$4, now())
       ON CONFLICT (global_key) DO UPDATE SET
         subject = EXCLUDED.subject, client_id = EXCLUDED.client_id,
         last_external_at = EXCLUDED.last_external_at, updated_at = now()
       RETURNING id`,
      [globalKey, `#${channelName}`, clientId, s.last_client_at ?? s.last_activity ?? new Date()],
    );
    const conversationId = Number(conv.rows[0]!.id);

    await c.query(
      `INSERT INTO items (conversation_id, source, state, reason, client_id, low_confidence,
                          summary, preview, pending_count, oldest_pending_at, oldest_pending_ts,
                          last_client_message_at, last_internal_message_at, last_external_at,
                          slack_channel_id, owner_user_id, slack_owner_id, updated_at)
       VALUES ($1,'slack',$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15, now())
       ON CONFLICT (conversation_id) DO UPDATE SET
         -- A person's call stands until the channel itself changes.
         state = CASE WHEN items.reason = 'ignored' AND $2 = 'needs_reply' AND items.pending_count = $7
                      THEN items.state ELSE EXCLUDED.state END,
         reason = CASE WHEN items.reason = 'ignored' AND $2 = 'needs_reply' AND items.pending_count = $7
                       THEN items.reason ELSE EXCLUDED.reason END,
         client_id = EXCLUDED.client_id,
         low_confidence = EXCLUDED.low_confidence,
         summary = EXCLUDED.summary,
         preview = EXCLUDED.preview,
         pending_count = EXCLUDED.pending_count,
         oldest_pending_at = EXCLUDED.oldest_pending_at,
         oldest_pending_ts = EXCLUDED.oldest_pending_ts,
         last_client_message_at = EXCLUDED.last_client_message_at,
         last_internal_message_at = EXCLUDED.last_internal_message_at,
         last_external_at = EXCLUDED.last_external_at,
         owner_user_id = COALESCE(items.owner_user_id, EXCLUDED.owner_user_id),
         slack_owner_id = COALESCE(items.slack_owner_id, EXCLUDED.slack_owner_id),
         updated_at = now()`,
      [
        conversationId, state, reason, clientId, lowConfidence,
        preview, pendingCount, s.oldest_pending_at, s.oldest_pending_ts,
        s.last_client_at, s.last_internal_at,
        s.oldest_pending_at ?? s.last_client_at ?? s.last_activity,
        channelId, owner.userId, owner.slackUserId,
      ],
    );
  });
}

/**
 * Why a channel with nothing pending is closed: because the last thing the
 * client said needed no answer, or because we answered.
 */
async function closedReason(channelId: string): Promise<string> {
  const last = await query<{ text: string }>(
    `SELECT text FROM slack_messages
      WHERE channel_id = $1 AND NOT is_internal AND NOT deleted ORDER BY ts DESC LIMIT 1`,
    [channelId],
  );
  if (last[0] && isAcknowledgement(last[0].text)) return 'not_needed';
  return 'replied';
}

/**
 * Who the channel's work sits with.
 *
 * Usually the person the client addressed in the oldest thing still waiting;
 * failing that, whoever from our side last spoke there. owner_user_id is set
 * only when that person has a ReplyQueue account -- most of the workspace
 * does not -- while the Slack identity is recorded either way, so the row
 * names somebody instead of reading "unowned".
 */
async function ownerForChannel(
  channelId: string,
  text: string,
): Promise<{ slackUserId: string | null; userId: number | null }> {
  const mentioned = [...text.matchAll(/<@([A-Z0-9_]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!);

  let slackUserId: string | null = null;
  if (mentioned.length > 0) {
    const rows = await query<{ id: string }>(
      `SELECT id FROM slack_users
        WHERE id = ANY($1::text[]) AND is_internal AND NOT is_bot
        ORDER BY array_position($1::text[], id) LIMIT 1`,
      [mentioned],
    );
    slackUserId = rows[0]?.id ?? null;
  }
  if (slackUserId == null) {
    const lastInternal = await query<{ user_id: string }>(
      `SELECT m.user_id FROM slack_messages m
         JOIN slack_users su ON su.id = m.user_id
        WHERE m.channel_id = $1 AND m.is_internal AND NOT m.deleted AND NOT su.is_bot
        ORDER BY m.ts DESC LIMIT 1`,
      [channelId],
    );
    slackUserId = lastInternal[0]?.user_id ?? null;
  }
  if (slackUserId == null) return { slackUserId: null, userId: null };

  const linked = await query<{ id: string }>(
    `SELECT u.id FROM slack_users su
       JOIN users u ON lower(u.email) = lower(su.email::text)
      WHERE su.id = $1 AND su.email IS NOT NULL LIMIT 1`,
    [slackUserId],
  );
  return { slackUserId, userId: linked[0] ? Number(linked[0].id) : null };
}
