import { query } from '../db/pool.js';
import { config, useRealClassifier } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { getLlmClient } from '../llm/index.js';

export interface WindowResult {
  channel: string;
  decided: number;
  skipped: 'quiet-pending' | null;
}

interface WindowMessage {
  id: string;
  author: string;
  internal: boolean;
  at: string;
  text: string;
  threadOf: string | null;
}

/**
 * Settles the ambiguous case: several client groups pending and one internal
 * message after them, so the deterministic rules cannot say which was
 * answered.
 *
 * Runs only once a channel has been quiet for SLACK_DEBOUNCE_MINUTES. A burst
 * mid-conversation would otherwise be judged before the answer arrives, and
 * every new line would pay for another call.
 */
export async function runSlackWindows(now: Date = new Date()): Promise<WindowResult[]> {
  const channels = await query<{ id: string; name: string; last_message_at: Date | null }>(
    `SELECT DISTINCT c.id, c.name, c.last_message_at
       FROM slack_channels c
       JOIN items i ON i.slack_channel_id = c.id
      WHERE c.watched AND i.state = 'needs_reply' AND i.low_confidence`,
  );

  const results: WindowResult[] = [];
  for (const ch of channels) {
    const quietFor = ch.last_message_at ? now.getTime() - new Date(ch.last_message_at).getTime() : Infinity;
    if (quietFor < config.slack.debounceMinutes * 60_000) {
      results.push({ channel: ch.name, decided: 0, skipped: 'quiet-pending' });
      continue;
    }
    results.push(await runWindowForChannel(ch.id, ch.name));
  }
  return results;
}

async function runWindowForChannel(channelId: string, channelName: string): Promise<WindowResult> {
  const pending = await query<{ slack_group_ts: string }>(
    `SELECT slack_group_ts FROM items
      WHERE slack_channel_id = $1 AND state = 'needs_reply' AND low_confidence
      ORDER BY slack_group_ts ASC`,
    [channelId],
  );
  if (pending.length === 0) return { channel: channelName, decided: 0, skipped: null };

  // Without a model there is no way to tell which group was answered. Treating
  // an answered-looking group as replied matches what the channel looks like
  // to a person, and low_confidence keeps it visible as a guess.
  if (!useRealClassifier()) {
    const closed = await query(
      `UPDATE items SET state = 'no_reply_needed', reason = 'replied', low_confidence = true, updated_at = now()
        WHERE slack_channel_id = $1 AND state = 'needs_reply' AND low_confidence
          AND EXISTS (
            SELECT 1 FROM slack_messages m
             WHERE m.channel_id = items.slack_channel_id AND m.is_internal AND NOT m.deleted
               AND m.ts > items.slack_group_ts
          )
        RETURNING id`,
      [channelId],
    );
    logger.warn(
      { channel: channelName, closed: closed.length },
      'no ANTHROPIC_API_KEY — closing answered-looking slack groups as low confidence',
    );
    return { channel: channelName, decided: closed.length, skipped: null };
  }

  const window = await buildWindow(channelId);
  if (window.length === 0) return { channel: channelName, decided: 0, skipped: null };

  const verdict = await askModel(channelName, window);
  if (!verdict) return { channel: channelName, decided: 0, skipped: null };

  let decided = 0;
  if (verdict.answered.length > 0) {
    const r = await query(
      `UPDATE items SET state = 'no_reply_needed', reason = 'replied', low_confidence = false, updated_at = now()
        WHERE slack_channel_id = $1 AND slack_group_ts = ANY($2::text[]) AND state = 'needs_reply'
        RETURNING id`,
      [channelId, verdict.answered],
    );
    decided += r.length;
  }
  if (verdict.unanswered.length > 0) {
    // Still open, but no longer a guess: the model looked and said so.
    const r = await query(
      `UPDATE items SET low_confidence = false, updated_at = now()
        WHERE slack_channel_id = $1 AND slack_group_ts = ANY($2::text[]) AND state = 'needs_reply'
        RETURNING id`,
      [channelId, verdict.unanswered],
    );
    decided += r.length;
  }

  return { channel: channelName, decided, skipped: null };
}

/** The messages since the last point where nothing was outstanding, capped at 30. */
async function buildWindow(channelId: string): Promise<WindowMessage[]> {
  const rows = await query<any>(
    `SELECT m.ts, m.thread_ts, m.is_internal, m.text, m.posted_at,
            COALESCE(u.name, m.user_id, 'unknown') AS author
       FROM slack_messages m
       LEFT JOIN slack_users u ON u.id = m.user_id
      WHERE m.channel_id = $1 AND NOT m.deleted
        AND m.ts >= COALESCE((SELECT resolved_through_ts FROM slack_channels WHERE id = $1), '0')
      ORDER BY m.ts DESC
      LIMIT 30`,
    [channelId],
  );
  return rows.reverse().map((r) => ({
    id: r.ts,
    author: r.author,
    internal: r.is_internal,
    at: new Date(r.posted_at).toISOString(),
    text: String(r.text).slice(0, 600),
    threadOf: r.thread_ts && r.thread_ts !== r.ts ? r.thread_ts : null,
  }));
}

interface Verdict { answered: string[]; unanswered: string[] }

/**
 * One internal message can answer several client messages, so the model is
 * asked to partition them rather than judge one at a time.
 */
async function askModel(channelName: string, window: WindowMessage[]): Promise<Verdict | null> {
  const transcript = window
    .map((m) => `[${m.id}] ${m.internal ? 'US' : 'CLIENT'} ${m.author} at ${m.at}${m.threadOf ? ` (in thread ${m.threadOf})` : ''}: ${m.text}`)
    .join('\n');

  const prompt = [
    `Slack channel #${channelName}. Each line is one message, prefixed with its id.`,
    'US is our team; CLIENT is the customer.',
    '',
    transcript,
    '',
    'Which CLIENT messages have been answered by a later US message, and which are still waiting on us?',
    'One US message may answer several CLIENT messages. A US message that only talks to colleagues answers nothing.',
    'Reply with strict JSON only:',
    '{"unanswered_client_message_ids": ["..."], "answered_client_message_ids": ["..."]}',
  ].join('\n');

  try {
    const raw = await getLlmClient().draftReply({
      subject: `slack-window:${channelName}`,
      thread: [{ from: 'system', date: new Date().toISOString(), body: prompt, direction: 'in' }],
      senderName: 'ReplyQueue',
    });
    const match = /\{[\s\S]*\}/.exec(raw);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      answered: asIds(parsed.answered_client_message_ids),
      unanswered: asIds(parsed.unanswered_client_message_ids),
    };
  } catch (err) {
    logger.warn({ channel: channelName, err }, 'slack window model call failed; leaving items as they are');
    return null;
  }
}

function asIds(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
}
