import type { PoolClient } from 'pg';
import { config } from '../lib/config.js';
import { addBusinessHours } from './sla.js';

export type ItemState =
  | 'needs_reply' | 'sending' | 'replied' | 'ignored' | 'snoozed'
  | 'fyi' | 'auto_ignored' | 'handled_elsewhere' | 'archived';

interface MessageRow {
  id: string;
  rfc_message_id: string;
  direction: 'in' | 'out';
  internal_date: Date;
  from_email: string;
  to_emails: string[];
  cc_emails: string[];
  filter_reason: string | null;
  is_draft: boolean;
  is_bounce: boolean;
}

interface ItemRow {
  id: string;
  state: ItemState;
  muted: boolean;
  snoozed_until: Date | null;
  state_since: Date;
  reopen_count: number;
  sending_since: Date | null;
}

export interface RecomputeOptions {
  /** Classification of the newest external message, when one was just ingested. */
  newestExternalNeedsReply?: boolean;
  now?: Date;
}

export interface RecomputeResult {
  state: ItemState;
  changed: boolean;
  event: string;
  previous: ItemState | null;
}

/** Latest external message that is not filtered, not a draft and not a bounce. */
function latestMeaningfulExternal(messages: MessageRow[]): MessageRow | null {
  const candidates = messages.filter((m) => m.direction === 'in' && !m.is_draft && !m.is_bounce && m.filter_reason === null);
  return candidates.length ? candidates[candidates.length - 1]! : null;
}

/**
 * Latest internal message that counts as a reply (SPEC 6): not a draft, and
 * addressed to at least one external participant of THIS conversation. An
 * internal-only forward is not a reply, and neither is a mail to an unrelated
 * outsider.
 */
function latestInternalReply(messages: MessageRow[], externalParticipants: Set<string>): MessageRow | null {
  const candidates = messages.filter((m) => {
    if (m.direction !== 'out' || m.is_draft) return false;
    const recipients = [...m.to_emails, ...m.cc_emails].map((e) => e.toLowerCase());
    return recipients.some((r) => externalParticipants.has(r));
  });
  return candidates.length ? candidates[candidates.length - 1]! : null;
}

/**
 * Recomputes an item's state from its messages (SPEC 5). This is the single
 * authority: ingestion, the nightly reconciliation and the merge path all call
 * it, so drift between them is impossible by construction.
 */
export async function recomputeItemState(
  c: PoolClient,
  conversationId: number,
  opts: RecomputeOptions = {},
): Promise<RecomputeResult | null> {
  const now = opts.now ?? new Date();

  const itemRes = await c.query<ItemRow>(
    'SELECT id, state, muted, snoozed_until, state_since, reopen_count, sending_since FROM items WHERE conversation_id = $1',
    [conversationId],
  );
  const item = itemRes.rows[0];
  if (!item) return null;

  const msgRes = await c.query<MessageRow>(
    `SELECT id, rfc_message_id, direction, internal_date, from_email, to_emails, cc_emails,
            filter_reason, is_draft, is_bounce
       FROM messages WHERE conversation_id = $1 ORDER BY internal_date ASC`,
    [conversationId],
  );
  const messages = msgRes.rows;

  const convRes = await c.query<{ participants_ext: string[] }>(
    'SELECT participants_ext FROM conversations WHERE id = $1',
    [conversationId],
  );
  const externalParticipants = new Set((convRes.rows[0]?.participants_ext ?? []).map((e) => e.toLowerCase()));

  const lastExternal = latestMeaningfulExternal(messages);
  const lastReply = latestInternalReply(messages, externalParticipants);

  const previous = item.state;
  let next: ItemState = previous;
  let event = 'recompute';

  // Every copy gone from every mailbox: soft delete (SPEC 5).
  const liveCopies = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM message_copies mc
       JOIN messages m ON m.id = mc.message_id
      WHERE m.conversation_id = $1 AND mc.deleted = false`,
    [conversationId],
  );
  if (Number(liveCopies.rows[0]?.n ?? 0) === 0 && messages.length > 0) {
    return applyState(c, item, 'archived', 'deleted_everywhere', now, previous);
  }

  if (!lastExternal) {
    // Nothing meaningful from outside: filtered or internal-only.
    next = previous === 'auto_ignored' || previous === 'archived' ? previous : 'auto_ignored';
    return applyState(c, item, next, 'no_meaningful_external', now, previous);
  }

  const repliedAfterExternal = lastReply !== null && lastReply.internal_date > lastExternal.internal_date;
  const externalAfterUserAction = lastExternal.internal_date > item.state_since;

  if (repliedAfterExternal) {
    next = 'replied';
    event = previous === 'replied' ? 'recompute' : 'reply_detected';
    return applyState(c, item, next, event, now, previous, { lastReply, lastExternal });
  }

  // From here on, the newest meaningful message is external and unanswered.
  switch (previous) {
    case 'ignored':
      if (item.muted) return applyState(c, item, 'ignored', 'muted', now, previous);
      next = externalAfterUserAction ? 'needs_reply' : 'ignored';
      event = externalAfterUserAction ? 'reopened_after_ignore' : 'recompute';
      break;

    case 'snoozed':
      if (externalAfterUserAction) {
        next = 'needs_reply';
        event = 'snooze_early_wake';
      } else if (item.snoozed_until && item.snoozed_until <= now) {
        next = 'needs_reply';
        event = 'snooze_expired';
      } else {
        next = 'snoozed';
      }
      break;

    case 'handled_elsewhere':
      next = externalAfterUserAction ? 'needs_reply' : 'handled_elsewhere';
      event = externalAfterUserAction ? 'reopened_after_handled' : 'recompute';
      break;

    case 'replied':
      // We only reach here when the newest meaningful message is external and
      // unanswered, so if a qualifying reply exists at all it is older than
      // that message: the client has written again. Comparing against
      // state_since would be wrong, because during backfill state_since is
      // wall-clock while the messages are historical.
      if (opts.newestExternalNeedsReply === false) {
        // "Thanks!" after our reply goes to FYI rather than reopening
        // (SPEC 12; decision 4).
        next = 'fyi';
        event = 'fyi_after_reply';
      } else {
        next = 'needs_reply';
        event = 'reopened';
        if (lastReply) await c.query('UPDATE items SET reopen_count = reopen_count + 1 WHERE id = $1', [item.id]);
      }
      break;

    case 'fyi':
      next = opts.newestExternalNeedsReply === true ? 'needs_reply' : 'fyi';
      event = next === 'needs_reply' ? 'fyi_upgraded' : 'recompute';
      break;

    case 'sending': {
      // Not confirmed in sync within 5 minutes: fail back (SPEC 5).
      const stale = item.sending_since !== null && now.getTime() - item.sending_since.getTime() > 5 * 60_000;
      next = stale ? 'needs_reply' : 'sending';
      event = stale ? 'send_unconfirmed' : 'recompute';
      break;
    }

    case 'auto_ignored':
      next = 'auto_ignored';
      break;

    case 'archived':
      next = 'archived';
      break;

    default:
      next = opts.newestExternalNeedsReply === false ? 'fyi' : 'needs_reply';
      break;
  }

  return applyState(c, item, next, event, now, previous, { lastExternal, lastReply });
}

async function applyState(
  c: PoolClient,
  item: ItemRow,
  next: ItemState,
  event: string,
  now: Date,
  previous: ItemState,
  ctx: { lastExternal?: MessageRow | null; lastReply?: MessageRow | null } = {},
): Promise<RecomputeResult> {
  const changed = next !== previous;

  const lastExternalAt = ctx.lastExternal?.internal_date ?? null;
  const repliedAt = next === 'replied' ? (ctx.lastReply?.internal_date ?? null) : null;
  const repliedBy = next === 'replied' ? (ctx.lastReply?.from_email ?? null) : null;
  const responseSeconds =
    next === 'replied' && ctx.lastReply && ctx.lastExternal
      ? Math.max(0, Math.round((ctx.lastReply.internal_date.getTime() - ctx.lastExternal.internal_date.getTime()) / 1000))
      : null;

  // SLA only runs while we owe a reply.
  const slaDueAt = next === 'needs_reply' && lastExternalAt ? await slaFor(c, item.id, lastExternalAt) : null;

  await c.query(
    `UPDATE items SET
       state = $2,
       state_since = CASE WHEN state <> $2 THEN $3 ELSE state_since END,
       last_external_at = COALESCE($4, last_external_at),
       last_external_message_id = COALESCE($5, last_external_message_id),
       replied_at = $6,
       replied_by = $7,
       response_time_seconds = $8,
       sla_due_at = $9,
       snoozed_until = CASE WHEN $2 <> 'snoozed' THEN NULL ELSE snoozed_until END,
       sending_since = CASE WHEN $2 <> 'sending' THEN NULL ELSE sending_since END,
       updated_at = now()
     WHERE id = $1`,
    [item.id, next, now, lastExternalAt, ctx.lastExternal?.rfc_message_id ?? null, repliedAt, repliedBy, responseSeconds, slaDueAt],
  );

  if (changed) {
    await c.query(
      'INSERT INTO item_events (item_id, from_state, to_state, event, actor, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [item.id, previous, next, event, 'system', JSON.stringify({})],
    );
  }

  return { state: next, changed, event, previous };
}

/** Per-client tier SLA if configured, otherwise the org default (SPEC 8). */
async function slaFor(c: PoolClient, itemId: string, from: Date): Promise<Date> {
  const res = await c.query<{ sla_hours: number | null }>(
    `SELECT cl.sla_hours FROM items i LEFT JOIN clients cl ON cl.id = i.client_id WHERE i.id = $1`,
    [itemId],
  );
  const hours = res.rows[0]?.sla_hours ?? config.sla.defaultHours;
  return addBusinessHours(from, hours);
}
