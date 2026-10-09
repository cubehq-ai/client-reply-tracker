import { query } from '../db/pool.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

export interface RetentionResult { purged: number; olderThanDays: number }

/**
 * Drops stored body text past the retention window, keeping metadata so the
 * queues and metrics still work (SPEC 11).
 */
export async function purgeOldBodies(): Promise<RetentionResult> {
  const days = config.org.bodyRetentionDays;
  const rows = await query<{ id: string }>(
    `UPDATE messages SET body_text_trunc = NULL, snippet = NULL, body_purged_at = now()
      WHERE internal_date < now() - ($1 || ' days')::interval
        AND body_text_trunc IS NOT NULL
      RETURNING id`,
    [String(days)],
  );
  logger.info({ purged: rows.length, days }, 'body retention purge complete');
  return { purged: rows.length, olderThanDays: days };
}
