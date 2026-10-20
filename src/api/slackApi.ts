import { query } from '../db/pool.js';
import { config, slackEnabled } from '../lib/config.js';
import { getSlackClient } from '../slack/index.js';
import { slackIdentity } from '../slack/sync.js';
import { reconcileChannel, syncOneChannel } from '../slack/ingest.js';
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
  if (!slackEnabled()) {
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
  const shouldBackfill = row[0].watched && row[0].backfilled_at == null && slackEnabled();
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
  permalink: string | null;
  postingAs: string | null;
  groupTs: string;
  messages: {
    ts: string;
    author: string;
    authorId: string | null;
    isInternal: boolean;
    text: string;
    at: string;
    threadOf: string | null;
    inGroup: boolean;
    deleted: boolean;
    reactions: Record<string, string[]>;
  }[];
}

/**
 * The channel around a Slack item: ten messages before the group, everything
 * after it, and the group's thread. Context is what makes a channel message
 * readable -- a bare line out of a conversation rarely is.
 */
export async function getSlackThread(itemId: number): Promise<SlackThreadView> {
  const item = await query<any>(
    `SELECT i.slack_channel_id, i.slack_group_ts, sc.name
       FROM items i JOIN slack_channels sc ON sc.id = i.slack_channel_id
      WHERE i.id = $1`,
    [itemId],
  );
  if (!item[0]) throw new HttpError(404, 'not a slack item');
  const { slack_channel_id: channelId, slack_group_ts: groupTs, name } = item[0];

  const rows = await query<any>(
    `WITH before AS (
       SELECT * FROM slack_messages
        WHERE channel_id = $1 AND ts < $2 AND (thread_ts IS NULL OR thread_ts = ts)
        ORDER BY ts DESC LIMIT 10
     ), rest AS (
       SELECT * FROM slack_messages
        WHERE channel_id = $1 AND (ts >= $2 OR thread_ts = $2)
     )
     SELECT m.*, COALESCE(u.name, m.user_id) AS author
       FROM (SELECT * FROM before UNION SELECT * FROM rest) m
       LEFT JOIN slack_users u ON u.id = m.user_id
      ORDER BY m.ts ASC`,
    [channelId, groupTs],
  );

  const groupIds = await query<{ ts: string }>(
    `SELECT ts FROM slack_messages WHERE channel_id = $1 AND conversation_id =
       (SELECT conversation_id FROM items WHERE id = $2)`,
    [channelId, itemId],
  );
  const inGroup = new Set(groupIds.map((g) => g.ts));

  // Mentions are ids on the wire; without the names the text is unreadable.
  const nameRows = await query<{ id: string; name: string }>('SELECT id, name FROM slack_users');
  const names = new Map(nameRows.map((r) => [r.id, r.name]));

  let permalink: string | null = null;
  if (slackEnabled()) permalink = await getSlackClient().permalink(channelId, groupTs);

  let postingAs: string | null = null;
  try {
    postingAs = slackEnabled() ? (await slackIdentity()).userName : null;
  } catch { postingAs = null; }

  return {
    channelId,
    channelName: name,
    permalink,
    postingAs,
    groupTs,
    messages: rows.map((r) => ({
      ts: r.ts,
      author: r.author ?? 'unknown',
      authorId: r.user_id,
      isInternal: r.is_internal,
      text: renderSlackText(r.text, names),
      at: new Date(r.posted_at).toISOString(),
      threadOf: r.thread_ts && r.thread_ts !== r.ts ? r.thread_ts : null,
      inGroup: inGroup.has(r.ts),
      deleted: r.deleted,
      reactions: r.reactions ?? {},
    })),
  };
}

/**
 * Replies to a Slack item.
 *
 * Always as a thread reply on the group's first message: that is what makes
 * the reply detectable on the next pass, whoever posted it and wherever the
 * channel has moved to since.
 */
export async function sendSlackReply(
  user: SessionUser,
  itemId: number,
  text: string,
): Promise<{ ok: true; dryRun: boolean; ts: string }> {
  if (!text.trim()) throw new HttpError(400, 'nothing to send');
  const item = await query<any>(
    'SELECT slack_channel_id, slack_group_ts, conversation_id FROM items WHERE id = $1',
    [itemId],
  );
  if (!item[0]?.slack_channel_id) throw new HttpError(404, 'not a slack item');

  const result = await getSlackClient().postMessage(item[0].slack_channel_id, text, item[0].slack_group_ts);

  await audit(user, 'slack_reply', itemId, { dryRun: result.dryRun, channel: item[0].slack_channel_id });

  // The item closes when sync sees the posted message, not now: a dry run
  // posts nothing, and treating it as answered would hide a real obligation.
  return { ok: true, dryRun: result.dryRun, ts: result.ts };
}
