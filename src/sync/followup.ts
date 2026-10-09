import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

export interface FollowUpResult { flagged: number; days: number }

/**
 * Awaiting Client follow-up (SPEC 6). An item we replied to, flagged as
 * "I'm waiting on them", with no client response after N days, surfaces in the
 * Awaiting Client queue. v1 is the explicit toggle only — no LLM inference.
 */
export async function sweepAwaitingClient(days = 3): Promise<FollowUpResult> {
  const rows = await query<{ id: string }>(
    `SELECT i.id FROM items i
      WHERE i.state = 'replied'
        AND i.awaiting_client = true
        AND i.replied_at < now() - ($1 || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM messages m
           WHERE m.conversation_id = i.conversation_id
             AND m.direction = 'in'
             AND m.internal_date > i.replied_at
        )`,
    [String(days)],
  );
  if (rows.length) logger.info({ count: rows.length, days }, 'items awaiting a client response');
  return { flagged: rows.length, days };
}

/**
 * Items stuck in `sending` past the 5-minute confirmation window fall back to
 * needs_reply with the error shown (SPEC 5).
 */
export async function sweepStuckSends(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE items SET state = 'needs_reply', sending_since = NULL,
                      last_error = COALESCE(last_error, 'send not confirmed in sync within 5 minutes'),
                      state_since = now(), updated_at = now()
      WHERE state = 'sending' AND sending_since < now() - interval '5 minutes'
      RETURNING id`,
  );
  if (rows.length) logger.warn({ count: rows.length }, 'sends not confirmed; returned to needs_reply');
  return rows.length;
}

/** Wakes snoozed items whose time has arrived (SPEC 5). */
export async function wakeSnoozed(): Promise<number> {
  const rows = await query<{ id: string }>(
    `UPDATE items SET state = 'needs_reply', snoozed_until = NULL, state_since = now(), updated_at = now()
      WHERE state = 'snoozed' AND snoozed_until IS NOT NULL AND snoozed_until <= now()
      RETURNING id`,
  );
  if (rows.length) logger.info({ count: rows.length }, 'snoozed items woken');
  return rows.length;
}

/** Expired composer locks (SPEC 9). */
export async function clearExpiredLocks(): Promise<number> {
  const rows = await query<{ item_id: string }>('DELETE FROM item_locks WHERE expires_at < now() RETURNING item_id');
  return rows.length;
}
