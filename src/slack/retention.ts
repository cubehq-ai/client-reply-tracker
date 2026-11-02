import { query } from '../db/pool.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

export interface SlackRetentionResult {
  /** Messages deleted from channels we still watch. */
  purged: number;
  /** Messages deleted because their channel is no longer watched at all. */
  droppedChannels: number;
  droppedMessages: number;
  keptDays: number;
  keepRecent: number;
}

/**
 * Deletes Slack messages nobody will read again.
 *
 * Slack is not mail. A channel is one endless conversation, the overwhelming
 * majority of it answered within minutes, and it arrives in order: once a
 * message is answered and the conversation has moved past it, the row is
 * storage and nothing else. #connector-statuses alone produced 16,000
 * messages in thirty days. Mail keeps its metadata and drops the body
 * (BODY_RETENTION_DAYS); here the metadata is the message, so the row goes.
 *
 * Four things are never deleted, in this order of importance:
 *
 *   1. A message still pending -- it is the work.
 *   2. Anything at or after the oldest pending message in its channel.
 *      Reconciliation recomputes pendingness from the messages it can see,
 *      so deleting around a pending message could change the answer; keeping
 *      the whole tail means the recomputation is bit-identical.
 *   3. Anything in a thread that holds a pending message, wherever it sits.
 *   4. The newest SLACK_KEEP_MESSAGES in each channel, and anything inside
 *      SLACK_RETENTION_DAYS -- the context the conversation view shows.
 *
 * What is left is answered, old, and below the window: chronologically the
 * front of the queue, exactly as it is safe to drop.
 */
export async function purgeSlackMessages(): Promise<SlackRetentionResult> {
  const days = config.slack.retentionDays;
  const keep = config.slack.keepRecentMessages;

  // An unwatched or archived channel is not client work: there is no item on
  // any list for it and nothing to recompute, so its messages go whole.
  // last_synced_ts and backfilled_at are reset with them, so re-watching the
  // channel in Settings backfills it again instead of resuming from a
  // high-water mark whose messages no longer exist.
  const dropped = await query<{ channel_id: string }>(
    `WITH gone AS (
       SELECT id FROM slack_channels WHERE NOT watched OR is_archived
     ), del AS (
       DELETE FROM slack_messages m USING gone WHERE m.channel_id = gone.id
       RETURNING m.channel_id
     )
     SELECT channel_id FROM del`,
  );
  if (dropped.length > 0) {
    await query(
      `UPDATE slack_channels
          SET last_synced_ts = NULL, backfilled_at = NULL, purged_through_ts = NULL,
              resolved_through_ts = NULL,
              messages_purged = messages_purged + sub.n, updated_at = now()
         FROM (SELECT channel_id, count(*)::int AS n FROM unnest($1::text[]) AS t(channel_id)
                GROUP BY channel_id) sub
        WHERE slack_channels.id = sub.channel_id`,
      [dropped.map((d) => d.channel_id)],
    );
  }

  const purged = await query<{ channel_id: string; ts: string }>(
    `WITH bounds AS (
       SELECT c.id AS channel_id,
              (SELECT min(p.ts::numeric) FROM slack_messages p
                WHERE p.channel_id = c.id AND p.pending AND NOT p.deleted) AS oldest_pending,
              (SELECT min(k.ts::numeric) FROM (
                 SELECT ts FROM slack_messages r
                  WHERE r.channel_id = c.id ORDER BY r.ts::numeric DESC LIMIT $2
               ) k) AS keep_from
         FROM slack_channels c
        WHERE c.watched AND NOT c.is_archived
     ), del AS (
       DELETE FROM slack_messages m
        USING bounds b
        WHERE m.channel_id = b.channel_id
          AND NOT m.pending
          AND m.posted_at < now() - ($1 || ' days')::interval
          -- Never cross the oldest thing still waiting, nor the newest N.
          AND (b.oldest_pending IS NULL OR m.ts::numeric < b.oldest_pending)
          AND (b.keep_from IS NULL OR m.ts::numeric < b.keep_from)
          -- A thread holding a pending message is kept entire: the question
          -- is unreadable without the message it hangs off.
          AND NOT EXISTS (
            SELECT 1 FROM slack_messages t
             WHERE t.channel_id = m.channel_id
               AND t.pending AND NOT t.deleted
               AND COALESCE(t.thread_ts, t.ts) = COALESCE(m.thread_ts, m.ts))
        RETURNING m.channel_id, m.ts
     )
     SELECT channel_id, ts FROM del`,
    [String(days), keep],
  );

  if (purged.length > 0) {
    // purged_through_ts is the watermark a reader needs to understand a
    // conversation view that starts mid-sentence.
    const byChannel = new Map<string, string>();
    for (const row of purged) {
      const prev = byChannel.get(row.channel_id);
      if (prev == null || Number(row.ts) > Number(prev)) byChannel.set(row.channel_id, row.ts);
    }
    for (const [channelId, ts] of byChannel) {
      await query(
        `UPDATE slack_channels
            SET purged_through_ts = GREATEST(COALESCE(purged_through_ts, '0'), $2),
                messages_purged = messages_purged + $3, updated_at = now()
          WHERE id = $1`,
        [channelId, ts, purged.filter((p) => p.channel_id === channelId).length],
      );
    }
  }

  const result: SlackRetentionResult = {
    purged: purged.length,
    droppedChannels: new Set(dropped.map((d) => d.channel_id)).size,
    droppedMessages: dropped.length,
    keptDays: days,
    keepRecent: keep,
  };
  logger.info(result, 'slack retention sweep complete');
  return result;
}
