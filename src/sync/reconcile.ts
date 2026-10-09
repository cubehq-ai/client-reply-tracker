import { query, tx } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { recomputeItemState } from '../pipeline/stateMachine.js';

export interface ReconcileResult {
  checked: number;
  changed: { itemId: number; from: string; to: string }[];
}

/**
 * Nightly reconciliation (SPEC 3.2): recompute every open item from the stored
 * messages. Catches drift from missed pushes, merges and crashed syncs.
 * Also wakes snoozed items whose time has come.
 */
export async function reconcileOpenItems(): Promise<ReconcileResult> {
  const rows = await query<{ id: string; conversation_id: string; state: string }>(
    `SELECT id, conversation_id, state FROM items
      WHERE state IN ('needs_reply','sending','snoozed','replied','fyi','handled_elsewhere','ignored')
      ORDER BY updated_at ASC`,
  );

  const changed: ReconcileResult['changed'] = [];
  for (const row of rows) {
    try {
      const result = await tx((c) => recomputeItemState(c, Number(row.conversation_id)));
      if (result?.changed) changed.push({ itemId: Number(row.id), from: result.previous ?? row.state, to: result.state });
    } catch (err) {
      logger.error({ itemId: row.id, err }, 'reconcile failed for item');
    }
  }
  logger.info({ checked: rows.length, changed: changed.length }, 'reconciliation complete');
  return { checked: rows.length, changed };
}
