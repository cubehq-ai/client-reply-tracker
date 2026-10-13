import { query, tx } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { recomputeItemState } from '../pipeline/stateMachine.js';
import { refreshConversation } from './mailboxSync.js';

export interface HourlyCheckResult {
  checked: number;
  refreshed: number;
  changed: { itemId: number; from: string; to: string }[];
  errors: number;
}

/**
 * Hourly status check over everything still waiting on us.
 *
 * The 10-minute poller only sees mailboxes we watch. This goes the other way:
 * for each open item it re-reads that specific thread from Gmail, which also
 * catches a reply sent from a mailbox outside the watch list, then recomputes
 * the state. Capped so one pass cannot run away on a large backlog.
 */
export async function checkUnrespondedItems(limit = 500): Promise<HourlyCheckResult> {
  const rows = await query<{ id: string; conversation_id: string; state: string }>(
    `SELECT id, conversation_id, state FROM items
      WHERE state IN ('needs_reply','sending','handled_elsewhere')
      ORDER BY updated_at ASC
      LIMIT $1`,
    [limit],
  );

  const changed: HourlyCheckResult['changed'] = [];
  let refreshed = 0;
  let errors = 0;

  for (const row of rows) {
    const conversationId = Number(row.conversation_id);
    try {
      await refreshConversation(conversationId);
      refreshed += 1;
    } catch (err) {
      // A thread we cannot re-read still gets recomputed from what we have.
      errors += 1;
      logger.warn({ conversationId, err }, 'hourly refresh failed for a conversation');
    }
    try {
      const result = await tx((c) => recomputeItemState(c, conversationId));
      if (result?.changed) changed.push({ itemId: Number(row.id), from: result.previous ?? row.state, to: result.state });
    } catch (err) {
      errors += 1;
      logger.error({ itemId: row.id, err }, 'hourly recompute failed');
    }
  }

  logger.info({ checked: rows.length, refreshed, changed: changed.length, errors }, 'hourly unresponded check complete');
  return { checked: rows.length, refreshed, changed, errors };
}
