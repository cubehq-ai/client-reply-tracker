import { query } from '../db/pool.js';
import { config, useRealClassifier } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { getLlmClient } from '../llm/index.js';
import { ambiguousClosures, computePending } from './pending.js';
import { writeChannelItem } from './ingest.js';
import type { StoredSlackMessage } from './groups.js';

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
export async function runSlackWindows(
  now: Date = new Date(),
  /** Whether a model is available. Defaults to the configured key; passed
   *  explicitly by tests, which never have one. */
  haveModel: boolean = useRealClassifier(),
): Promise<WindowResult[]> {
  const channels = await query<{ id: string; name: string; last_message_at: Date | null }>(
    `SELECT c.id, c.name, c.last_message_at
       FROM slack_channels c
      WHERE c.watched AND NOT c.is_archived`,
  );

  const results: WindowResult[] = [];
  for (const ch of channels) {
    const quietFor = ch.last_message_at ? now.getTime() - new Date(ch.last_message_at).getTime() : Infinity;
    if (quietFor < config.slack.debounceMinutes * 60_000) {
      results.push({ channel: ch.name, decided: 0, skipped: 'quiet-pending' });
      continue;
    }
    results.push(await runWindowForChannel(ch.id, ch.name, haveModel));
  }
  return results;
}

async function runWindowForChannel(channelId: string, channelName: string, haveModel: boolean): Promise<WindowResult> {
  // Only the ambiguity matters here: one internal message credited with
  // answering two or more client messages. Everything else was settled by a
  // thread reply, a tick or an acknowledgement, which are facts.
  const messages = await loadMessages(channelId);
  const internal = new Set(
    (await query<{ id: string }>('SELECT id FROM slack_users WHERE is_internal')).map((r) => r.id),
  );
  const result = computePending(messages, internal);
  const suspect = ambiguousClosures(result);
  if (suspect.length === 0) return { channel: channelName, decided: 0, skipped: null };

  if (!haveModel) {
    // Rule 3's answer stands, but it is a guess about which question was
    // answered, and the row says so rather than hiding it.
    await query(
      `UPDATE items SET low_confidence = true, updated_at = now() WHERE slack_channel_id = $1`,
      [channelId],
    );
    logger.warn({ channel: channelName, suspect: suspect.length },
      'no ANTHROPIC_API_KEY — keeping rule 3 and marking the channel low confidence');
    return { channel: channelName, decided: 0, skipped: null };
  }

  const window = await buildWindow(channelId);
  if (window.length === 0) return { channel: channelName, decided: 0, skipped: null };

  const unanswered = await askModel(channelName, window);
  if (unanswered == null) return { channel: channelName, decided: 0, skipped: null };

  // Only the suspect ones may be reopened: a message the model did not look
  // at, or one closed by a fact, is not its to overturn.
  const reopen = unanswered.filter((ts) => suspect.includes(ts));
  if (reopen.length > 0) {
    await query(
      'UPDATE slack_messages SET pending = true WHERE channel_id = $1 AND ts = ANY($2::text[])',
      [channelId, reopen],
    );
  }

  const ch = await query<{ name: string; client_id: string | null }>(
    'SELECT name, client_id FROM slack_channels WHERE id = $1', [channelId],
  );
  await writeChannelItem(channelId, ch[0]!.name, ch[0]!.client_id == null ? null : Number(ch[0]!.client_id), false);
  return { channel: channelName, decided: reopen.length, skipped: null };
}

async function loadMessages(channelId: string): Promise<StoredSlackMessage[]> {
  const rows = await query<any>(
    `SELECT ts, thread_ts, user_id, is_internal, text, reactions, deleted, posted_at
       FROM slack_messages WHERE channel_id = $1 ORDER BY ts ASC`,
    [channelId],
  );
  return rows.map((r) => ({
    ts: r.ts, threadTs: r.thread_ts, userId: r.user_id, isInternal: r.is_internal,
    text: r.text, reactions: r.reactions ?? {}, deleted: r.deleted, postedAt: new Date(r.posted_at),
  }));
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

/**
 * One internal message can answer several client messages, so the question is
 * which of them it did NOT answer.
 */
async function askModel(channelName: string, window: WindowMessage[]): Promise<string[] | null> {
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
    '{"unanswered_client_message_ids": ["..."]}',
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
    return asIds(parsed.unanswered_client_message_ids);
  } catch (err) {
    logger.warn({ channel: channelName, err }, 'slack window model call failed; leaving items as they are');
    return null;
  }
}

function asIds(v: unknown): string[] {
  return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
}
