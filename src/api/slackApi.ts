import { query } from '../db/pool.js';
import { config } from '../lib/config.js';
import { getSlackClient, slackConfigured } from '../slack/index.js';
import { slackIdentity } from '../slack/sync.js';
import { reconcileChannel, syncOneChannel, writeChannelItem } from '../slack/ingest.js';
import { invalidateOrgContext } from '../pipeline/context.js';
import { renderSlackText } from '../slack/text.js';
import type { SessionUser } from './auth.js';
import { HttpError } from './auth.js';
import { audit } from './actions.js';

export interface SlackStatus {
  connected: boolean;
  sendEnabled: boolean;
  /** Who replies are posted as. Shown in the composer so nobody is surprised. */
  postingAs: { userId: string; userName: string; teamName: string } | null;
  watchedChannels: number;
  unmappedChannels: number;
}

export async function slackStatus(): Promise<SlackStatus> {
  if (!slackConfigured()) {
    return { connected: false, sendEnabled: false, postingAs: null, watchedChannels: 0, unmappedChannels: 0 };
  }
  const counts = await query<{ watched: string; unmapped: string }>(
    `SELECT count(*) FILTER (WHERE watched) AS watched,
            count(*) FILTER (WHERE client_id IS NULL) AS unmapped
       FROM slack_channels WHERE NOT is_archived`,
  );
  let postingAs: SlackStatus['postingAs'] = null;
  try {
    const me = await slackIdentity();
    postingAs = { userId: me.userId, userName: me.userName, teamName: me.teamName };
  } catch {
    // A bad or revoked token must not take the page down; it shows as
    // connected-but-unidentified and the sync log carries the error.
    postingAs = null;
  }
  return {
    connected: true,
    sendEnabled: config.slack.sendEnabled,
    postingAs,
    watchedChannels: Number(counts[0]?.watched ?? 0),
    unmappedChannels: Number(counts[0]?.unmapped ?? 0),
  };
}

export async function listSlackChannels(): Promise<any[]> {
  return query(
    `SELECT sc.id, sc.name, sc.is_private, sc.is_shared, sc.watched, sc.mapping_source,
            sc.client_id, cl.name AS client_name, sc.last_synced_ts, sc.last_message_at,
            (SELECT count(*) FROM items i WHERE i.slack_channel_id = sc.id AND i.state = 'needs_reply') AS open_items
       FROM slack_channels sc
       LEFT JOIN clients cl ON cl.id = sc.client_id
      WHERE NOT sc.is_archived
      ORDER BY sc.watched DESC, sc.name ASC`,
  );
}

/**
 * Sets a channel's client or watch flag.
 *
 * Mapping by hand marks it manual, which the auto pass then leaves alone --
 * a person looked at this channel and the sync should not argue.
 */
export async function updateSlackChannel(
  user: SessionUser,
  channelId: string,
  patch: { clientId?: number | null; watched?: boolean },
): Promise<{ ok: true; backfilled: boolean }> {
  if (user.role === 'member') throw new HttpError(403, 'only managers and admins can map channels');

  const existing = await query<any>('SELECT id, backfilled_at FROM slack_channels WHERE id = $1', [channelId]);
  if (!existing[0]) throw new HttpError(404, 'channel not found');

  if (patch.clientId !== undefined) {
    await query(
      `UPDATE slack_channels SET client_id = $2, mapping_source = 'manual', updated_at = now() WHERE id = $1`,
      [channelId, patch.clientId],
    );
  }
  if (patch.watched !== undefined) {
    await query('UPDATE slack_channels SET watched = $2, updated_at = now() WHERE id = $1', [channelId, patch.watched]);
  }
  invalidateOrgContext();

  // Watching a channel for the first time backfills it, so mapping one is
  // useful immediately rather than at the next poll.
  const row = await query<any>('SELECT name, watched, last_synced_ts, backfilled_at FROM slack_channels WHERE id = $1', [channelId]);
  const shouldBackfill = row[0].watched && row[0].backfilled_at == null && slackConfigured();
  if (shouldBackfill) {
    await syncOneChannel(channelId, row[0].name, null, false);
    return { ok: true, backfilled: true };
  }
  if (row[0].watched) await reconcileChannel(channelId);
  return { ok: true, backfilled: false };
}

export interface SlackThreadView {
  channelId: string;
  channelName: string;
  clientName: string | null;
  permalink: string | null;
  postingAs: string | null;
  pendingCount: number;
  oldestPendingTs: string | null;
  messages: {
    ts: string;
    author: string;
    authorId: string | null;
    isInternal: boolean;
    text: string;
    at: string;
    threadOf: string | null;
    pending: boolean;
    deleted: boolean;
    reactions: Record<string, string[]>;
  }[];
}

/**
 * The channel behind an item: its last 50 messages, with the ones still
 * waiting on us marked. A channel is the unit of work, so the view is the
 * channel rather than an extract around one message.
 */
export async function getSlackThread(itemId: number): Promise<SlackThreadView> {
  const item = await query<any>(
    `SELECT i.slack_channel_id, i.pending_count, i.oldest_pending_ts, sc.name, cl.name AS client_name
       FROM items i
       JOIN slack_channels sc ON sc.id = i.slack_channel_id
       LEFT JOIN clients cl ON cl.id = i.client_id
      WHERE i.id = $1`,
    [itemId],
  );
  if (!item[0]) throw new HttpError(404, 'not a slack item');
  const channelId = item[0].slack_channel_id;

  const rows = await query<any>(
    `SELECT * FROM (
       SELECT m.*, COALESCE(u.name, m.user_id) AS author
         FROM slack_messages m
         LEFT JOIN slack_users u ON u.id = m.user_id
        WHERE m.channel_id = $1
        ORDER BY m.ts DESC
        LIMIT 50
     ) recent ORDER BY ts ASC`,
    [channelId],
  );

  const nameRows = await query<{ id: string; name: string }>('SELECT id, name FROM slack_users');
  const names = new Map(nameRows.map((r) => [r.id, r.name]));

  let permalink: string | null = null;
  if (slackConfigured()) permalink = await getSlackClient().permalink(channelId, item[0].oldest_pending_ts ?? rows[rows.length - 1]?.ts ?? '');

  let postingAs: string | null = null;
  try { postingAs = slackConfigured() ? (await slackIdentity()).userName : null; } catch { postingAs = null; }

  return {
    channelId,
    channelName: item[0].name,
    clientName: item[0].client_name ?? null,
    permalink,
    postingAs,
    pendingCount: Number(item[0].pending_count ?? 0),
    oldestPendingTs: item[0].oldest_pending_ts ?? null,
    messages: rows.map((r) => ({
      ts: r.ts,
      author: r.author ?? 'unknown',
      authorId: r.user_id,
      isInternal: r.is_internal,
      text: renderSlackText(r.text, names),
      at: new Date(r.posted_at).toISOString(),
      threadOf: r.thread_ts && r.thread_ts !== r.ts ? r.thread_ts : null,
      pending: Boolean(r.pending),
      deleted: r.deleted,
      reactions: r.reactions ?? {},
    })),
  };
}

/**
 * Marks client messages answered by hand.
 *
 * Without a ts it clears the whole channel: "mark as read", for the common
 * case where the conversation was handled in Slack itself, or in a call, and
 * the queue is simply out of date. Unwatching a channel entirely is a
 * different decision and lives in Settings.
 */
export async function markSlackAnswered(
  user: SessionUser,
  itemId: number,
  ts: string | null,
): Promise<{ ok: true; cleared: number }> {
  const item = await query<any>(
    'SELECT slack_channel_id FROM items WHERE id = $1 AND slack_channel_id IS NOT NULL',
    [itemId],
  );
  if (!item[0]) throw new HttpError(404, 'not a slack item');
  const channelId = item[0].slack_channel_id;

  // Recorded, not just unset: reconciliation recomputes `pending` from the
  // rules on every pass and would otherwise reopen this within minutes.
  const cleared = ts
    ? await query(
        `UPDATE slack_messages SET pending = false, answered_at = now(), answered_by = $3
          WHERE channel_id = $1 AND ts = $2 AND pending RETURNING id`,
        [channelId, ts, user.email])
    : await query(
        `UPDATE slack_messages SET pending = false, answered_at = now(), answered_by = $2
          WHERE channel_id = $1 AND pending RETURNING id`,
        [channelId, user.email]);

  const ch = await query<any>('SELECT name, client_id FROM slack_channels WHERE id = $1', [channelId]);
  await writeChannelItem(channelId, ch[0].name, ch[0].client_id == null ? null : Number(ch[0].client_id), false);

  await audit(user, ts ? 'slack_mark_answered' : 'slack_mark_channel_read', itemId, {
    channel: channelId, ts, cleared: cleared.length,
  });
  return { ok: true, cleared: cleared.length };
}

