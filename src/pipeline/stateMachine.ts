import type { PoolClient } from 'pg';
import { config } from '../lib/config.js';
import { addBusinessHours } from './sla.js';

/** Two states only (CLAUDE.md override 1). Why it is closed lives in `reason`. */
export type ItemState = 'needs_reply' | 'no_reply_needed';

export type ItemReason = 'replied' | 'not_needed' | 'filtered' | 'ignored';

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
  reason: ItemReason | null;
  muted: boolean;
  state_since: Date;
  acted_on_external_at: Date | null;
  reopen_count: number;
}

export interface RecomputeOptions {
  /** Classification of the newest external message, when one was just ingested. */
  newestExternalNeedsReply?: boolean;
  now?: Date;
}

export interface RecomputeResult {
  state: ItemState;
  reason: ItemReason | null;
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
    `SELECT id, state, reason, muted, state_since, acted_on_external_at, reopen_count
       FROM items WHERE conversation_id = $1`,
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
  const previousReason = item.reason;

  // Every copy gone from every mailbox: close it as filtered (SPEC 5).
  const liveCopies = await c.query<{ n: string }>(
    `SELECT count(*) AS n FROM message_copies mc
       JOIN messages m ON m.id = mc.message_id
      WHERE m.conversation_id = $1 AND mc.deleted = false`,
    [conversationId],
  );
  if (Number(liveCopies.rows[0]?.n ?? 0) === 0 && messages.length > 0) {
    return applyState(c, item, 'no_reply_needed', 'filtered', 'deleted_everywhere', now, previous);
  }

  if (!lastExternal) {
    // Nothing meaningful from outside: filtered or internal-only.
    return applyState(c, item, 'no_reply_needed', 'filtered', 'no_meaningful_external', now, previous);
  }

  const repliedAfterExternal = lastReply !== null && lastReply.internal_date > lastExternal.internal_date;

  // An internal reply closes the item, whatever it was before.
  if (repliedAfterExternal) {
    return applyState(c, item, 'no_reply_needed', 'replied', 'reply_detected', now, previous, { lastReply, lastExternal });
  }

  // From here the newest meaningful message is external and unanswered.
  const externalAfterUserAction =
    item.acted_on_external_at !== null
      ? lastExternal.internal_date > item.acted_on_external_at
      : lastExternal.internal_date > item.state_since;

  // A muted thread never reopens, however much they write.
  if (item.muted) {
    return applyState(c, item, 'no_reply_needed', previousReason ?? 'ignored', 'muted', now, previous);
  }

  // The classifier decided this specific message needs nothing.
  if (opts.newestExternalNeedsReply === false) {
    return applyState(c, item, 'no_reply_needed', 'not_needed', 'classified_not_needed', now, previous, { lastExternal });
  }

  // A closed item reopens when the client writes again after it was closed.
  if (previous === 'no_reply_needed') {
    const reopen = opts.newestExternalNeedsReply === true || previousReason === 'replied';
    if (!reopen || (previousReason === 'ignored' && !externalAfterUserAction)) {
      return applyState(c, item, 'no_reply_needed', previousReason ?? 'not_needed', 'recompute', now, previous, { lastExternal });
    }
    if (previousReason === 'replied' || externalAfterUserAction) {
      await c.query('UPDATE items SET reopen_count = reopen_count + 1 WHERE id = $1', [item.id]);
    }
    return applyState(c, item, 'needs_reply', null, 'reopened', now, previous, { lastExternal });
  }

  return applyState(c, item, 'needs_reply', null, 'recompute', now, previous, { lastExternal, lastReply });
}

async function applyState(
  c: PoolClient,
  item: ItemRow,
  next: ItemState,
  reason: ItemReason | null,
  event: string,
  now: Date,
  previous: ItemState,
  ctx: { lastExternal?: MessageRow | null; lastReply?: MessageRow | null } = {},
): Promise<RecomputeResult> {
  const changed = next !== previous || reason !== item.reason;

  const lastExternalAt = ctx.lastExternal?.internal_date ?? null;
  const isReplied = reason === 'replied';
  const repliedAt = isReplied ? (ctx.lastReply?.internal_date ?? null) : null;
  const repliedBy = isReplied ? (ctx.lastReply?.from_email ?? null) : null;
  const responseSeconds =
    isReplied && ctx.lastReply && ctx.lastExternal
      ? Math.max(0, Math.round((ctx.lastReply.internal_date.getTime() - ctx.lastExternal.internal_date.getTime()) / 1000))
      : null;

  // SLA only runs while we owe a reply.
  const slaDueAt = next === 'needs_reply' && lastExternalAt ? await slaFor(c, item.id, lastExternalAt) : null;

  await c.query(
    `UPDATE items SET
       state = $2,
       reason = $10,
       state_since = CASE WHEN state <> $2 THEN $3 ELSE state_since END,
       last_external_at = COALESCE($4, last_external_at),
       last_external_message_id = COALESCE($5, last_external_message_id),
       replied_at = $6,
       replied_by = $7,
       response_time_seconds = $8,
       sla_due_at = $9,
       updated_at = now()
     WHERE id = $1`,
    [item.id, next, now, lastExternalAt, ctx.lastExternal?.rfc_message_id ?? null, repliedAt, repliedBy, responseSeconds, slaDueAt, reason],
  );

  if (changed) {
    await c.query(
      'INSERT INTO item_events (item_id, from_state, to_state, event, actor, detail) VALUES ($1,$2,$3,$4,$5,$6)',
      [item.id, previous, next, event, 'system', JSON.stringify({ reason })],
    );
  }

  return { state: next, reason, changed, event, previous };
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
