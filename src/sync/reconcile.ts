import { query, tx } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { recomputeItemState } from '../pipeline/stateMachine.js';
import { reconcileChannel } from '../slack/ingest.js';

export interface ReconcileResult {
  checked: number;
  changed: { itemId: number; from: string; to: string }[];
  /** Slack channels recomputed by their own rules. */
  slackChannels: number;
}

/**
 * Nightly reconciliation (SPEC 3.2): recompute every open item from the stored
 * messages. Catches drift from missed pushes, merges and crashed syncs.
 *
 * Mail items only. A Slack item's conversation has no rows in `messages` --
 * Slack messages live in their own table -- so putting one through the mail
 * state machine was asking "how many external emails are in this channel?",
 * getting none, and closing it. It silently took nine open Slack channels
 * down to three. Slack has its own recomputation and it runs below.
 */
export async function reconcileOpenItems(): Promise<ReconcileResult> {
  const rows = await query<{ id: string; conversation_id: string; state: string }>(
    `SELECT id, conversation_id, state FROM items
      WHERE source = 'gmail'
        AND (state = 'needs_reply' OR reason IN ('replied','not_needed'))
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
  // Slack's own pass, by the rules that know what a channel is.
  const channels = await query<{ id: string }>(
    'SELECT id FROM slack_channels WHERE watched AND NOT is_archived',
  );
  let slackChannels = 0;
  for (const ch of channels) {
    try {
      await reconcileChannel(ch.id);
      slackChannels += 1;
    } catch (err) {
      logger.error({ channel: ch.id, err }, 'reconcile failed for slack channel');
    }
  }

  logger.info({ checked: rows.length, changed: changed.length, slackChannels }, 'reconciliation complete');
  return { checked: rows.length, changed, slackChannels };
}
