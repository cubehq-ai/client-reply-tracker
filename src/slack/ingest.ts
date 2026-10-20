import { query, tx } from '../db/pool.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { classifyMessage } from '../pipeline/classify.js';
import { getSlackClient, slackConfigured } from './index.js';
import { groupClientMessages, isAcknowledgement, resolveGroup, type StoredSlackMessage } from './groups.js';
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
 * Turns a channel's stored messages into items, one per pending client group.
 *
 * Runs over the whole channel rather than the new messages alone: a reply
 * arriving now can close a group from last week, and a group's standing is
 * only meaningful relative to everything after it.
 */
export async function reconcileChannel(channelId: string): Promise<number> {
  const ch = await query<{ name: string; client_id: string | null }>(
    'SELECT name, client_id FROM slack_channels WHERE id = $1',
    [channelId],
  );
  if (!ch[0]) return 0;

  const messages = await loadChannelMessages(channelId);
  const topLevel = messages.filter((m) => m.threadTs === null || m.threadTs === m.ts);
  const internal = await internalUserIds();
  const groups = groupClientMessages(topLevel);

  // Which groups are still open decides rule 4, so it is computed first over
  // the deterministic rules only.
  const provisional = groups.map((g) => {
    const after = topLevel.filter((m) => m.isInternal && !m.deleted && Number(m.ts) > Number(g.groupTs));
    const threadReplies = messages.filter((m) => m.threadTs === g.groupTs && m.ts !== g.groupTs);
    return { group: g, after, threadReplies };
  });

  const settledReplied = new Set<string>();
  for (const p of provisional) {
    const r = resolveGroup({
      group: p.group,
      threadReplies: p.threadReplies,
      internalUserIds: internal,
      internalTopLevelAfter: p.after,
      pendingGroupCount: 1, // first pass: thread replies and ticks only
    });
    if (r.replied && (r.reason === 'thread_reply' || r.reason === 'tick_reaction')) settledReplied.add(p.group.groupTs);
  }

  const pendingCount = provisional.filter((p) => !settledReplied.has(p.group.groupTs)).length;

  let items = 0;
  for (const p of provisional) {
    const groupTs = p.group.groupTs;
    const text = p.group.messages.map((m) => m.text).join('\n').trim();
    const allDeleted = p.group.messages.every((m) => m.deleted);

    let replied = settledReplied.has(groupTs);
    let reason: string | null = replied ? 'replied' : null;
    let lowConfidence = false;

    if (!replied) {
      const r = resolveGroup({
        group: p.group,
        threadReplies: p.threadReplies,
        internalUserIds: internal,
        internalTopLevelAfter: p.after,
        pendingGroupCount: pendingCount,
      });
      if (r.replied) { replied = true; reason = 'replied'; }
      else if (r.reason === null) {
        // Ambiguous: several groups pending and one internal message after
        // them. The LLM window decides, once the channel goes quiet.
        lowConfidence = true;
      }
    }

    let state = replied ? 'no_reply_needed' : 'needs_reply';
    let summary = text.split('\n')[0]?.slice(0, 160) ?? '';

    if (allDeleted) {
      state = 'no_reply_needed';
      reason = 'filtered';
    } else if (!replied) {
      // An acknowledgement needs no reply, and also means everything we were
      // still waiting on in this channel has landed.
      if (isAcknowledgement(text)) {
        state = 'no_reply_needed';
        reason = 'not_needed';
      } else {
        const verdict = await classifyMessage(`slack:${channelId}:${groupTs}`, {
          subject: `#${ch[0].name}`,
          body: text,
          lastInternalBody: lastInternalBefore(topLevel, groupTs),
        });
        summary = verdict.summary || summary;
        if (!verdict.needsReply) { state = 'no_reply_needed'; reason = 'not_needed'; }
        if (verdict.confidence < config.classifier.threshold) lowConfidence = true;
      }
    }

    const owner = await ownerForGroup(channelId, p.group.messages.map((m) => m.text).join('\n'));
    await upsertSlackItem({
      ownerUserId: owner.userId,
      ownerSlackId: owner.slackUserId,
      channelId,
      channelName: ch[0].name,
      clientId: ch[0].client_id == null ? null : Number(ch[0].client_id),
      groupTs,
      state,
      reason,
      lowConfidence,
      summary,
      lastExternalAt: p.group.messages[p.group.messages.length - 1]!.postedAt,
      messageTs: p.group.messages.map((m) => m.ts),
    });
    items += 1;
  }

  await closeEarlierGroupsOnAcknowledgement(channelId, groups.map((g) => g.groupTs));
  await closeDeletedGroups(channelId, groups.map((g) => g.groupTs));
  return items;
}

/**
 * Grouping skips deleted messages, so a group whose every message was deleted
 * stops existing and its item would otherwise sit open forever. The client
 * withdrew the message; there is nothing left to answer.
 */
async function closeDeletedGroups(channelId: string, liveGroupTs: string[]): Promise<void> {
  await query(
    `UPDATE items
        SET state = 'no_reply_needed', reason = 'filtered', low_confidence = false, updated_at = now()
      WHERE slack_channel_id = $1
        AND NOT (slack_group_ts = ANY($2::text[]))
        AND state = 'needs_reply'`,
    [channelId, liveGroupTs],
  );
}

function lastInternalBefore(topLevel: StoredSlackMessage[], groupTs: string): string | undefined {
  const before = topLevel.filter((m) => m.isInternal && Number(m.ts) < Number(groupTs));
  return before[before.length - 1]?.text;
}

/**
 * A client saying "thanks" closes what came before it: they would not be
 * thanking us if they were still waiting.
 */
async function closeEarlierGroupsOnAcknowledgement(channelId: string, groupTsList: string[]): Promise<void> {
  const acks = await query<{ slack_group_ts: string }>(
    `SELECT slack_group_ts FROM items
      WHERE slack_channel_id = $1 AND reason = 'not_needed' AND state = 'no_reply_needed'`,
    [channelId],
  );
  for (const ack of acks) {
    const earlier = groupTsList.filter((ts) => Number(ts) < Number(ack.slack_group_ts));
    if (earlier.length === 0) continue;
    await query(
      `UPDATE items
          SET state = 'no_reply_needed', reason = 'replied', updated_at = now()
        WHERE slack_channel_id = $1 AND slack_group_ts = ANY($2::text[]) AND state = 'needs_reply'`,
      [channelId, earlier],
    );
  }
}

/**
 * Who a client's message is addressed to.
 *
 * A channel has no mailbox, so nothing set an owner and every Slack row read
 * "owner: unowned". The message itself usually says: people open with
 * "Hi @Shireen @Sahana". Those mentions, narrowed to our own people and
 * matched to a user by email, are the owner. Failing that, whoever from our
 * side last spoke in the channel is the one carrying it.
 */
async function ownerForGroup(
  channelId: string,
  groupText: string,
): Promise<{ slackUserId: string | null; userId: number | null }> {
  const mentioned = [...groupText.matchAll(/<@([A-Z0-9_]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!);

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

  // Link to a ReplyQueue account when that person has one, so the visibility
  // rules and the owner filter keep working; the Slack identity stands either
  // way, because most of the workspace has no account here.
  const linked = await query<{ id: string }>(
    `SELECT u.id FROM slack_users su
       JOIN users u ON lower(u.email) = lower(su.email::text)
      WHERE su.id = $1 AND su.email IS NOT NULL LIMIT 1`,
    [slackUserId],
  );
  return { slackUserId, userId: linked[0] ? Number(linked[0].id) : null };
}

interface UpsertInput {
  channelId: string;
  channelName: string;
  clientId: number | null;
  groupTs: string;
  state: string;
  reason: string | null;
  lowConfidence: boolean;
  summary: string;
  lastExternalAt: Date;
  messageTs: string[];
  ownerUserId: number | null;
  ownerSlackId: string | null;
}

/**
 * One conversation and one item per client group.
 *
 * A user's own decision outranks a recomputation: an item someone ignored or
 * marked as needing no reply is not reopened by a later pass unless a client
 * message actually arrives in its group.
 */
async function upsertSlackItem(input: UpsertInput): Promise<void> {
  await tx(async (c) => {
    const globalKey = `slack:${input.channelId}:${input.groupTs}`;
    const conv = await c.query<{ id: string }>(
      `INSERT INTO conversations (global_key, subject, client_id, first_external_at, last_external_at, updated_at)
       VALUES ($1,$2,$3,$4,$4, now())
       ON CONFLICT (global_key) DO UPDATE SET
         subject = EXCLUDED.subject, client_id = EXCLUDED.client_id,
         last_external_at = EXCLUDED.last_external_at, updated_at = now()
       RETURNING id`,
      [globalKey, `#${input.channelName}`, input.clientId, input.lastExternalAt],
    );
    const conversationId = Number(conv.rows[0]!.id);

    await c.query(
      `INSERT INTO items (conversation_id, source, state, reason, client_id, low_confidence,
                          summary, last_external_at, slack_channel_id, slack_group_ts,
                          owner_user_id, slack_owner_id, updated_at)
       VALUES ($1,'slack',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
       ON CONFLICT (conversation_id) DO UPDATE SET
         -- A person's call stands: only 'replied' and 'filtered', which are
         -- facts about the channel rather than judgements, may overwrite it.
         state = CASE WHEN items.reason IN ('ignored','not_needed') AND $3 NOT IN ('replied','filtered')
                      THEN items.state ELSE EXCLUDED.state END,
         reason = CASE WHEN items.reason IN ('ignored','not_needed') AND $3 NOT IN ('replied','filtered')
                       THEN items.reason ELSE EXCLUDED.reason END,
         client_id = EXCLUDED.client_id,
         low_confidence = EXCLUDED.low_confidence,
         summary = COALESCE(NULLIF(EXCLUDED.summary, ''), items.summary),
         last_external_at = EXCLUDED.last_external_at,
         -- Never clear an owner a person assigned by hand.
         owner_user_id = COALESCE(items.owner_user_id, EXCLUDED.owner_user_id),
         slack_owner_id = COALESCE(items.slack_owner_id, EXCLUDED.slack_owner_id),
         updated_at = now()`,
      [
        conversationId, input.state, input.reason, input.clientId, input.lowConfidence,
        input.summary, input.lastExternalAt, input.channelId, input.groupTs,
        input.ownerUserId, input.ownerSlackId,
      ],
    );

    await c.query(
      'UPDATE slack_messages SET conversation_id = $1 WHERE channel_id = $2 AND ts = ANY($3::text[])',
      [conversationId, input.channelId, input.messageTs],
    );
  });
}
