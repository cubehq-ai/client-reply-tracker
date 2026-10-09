import { query } from '../db/pool.js';
import { getGmailClient } from '../gmail/index.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

export interface WatchResult {
  renewed: number;
  skipped: number;
  failed: number;
  reason?: string;
}

/**
 * Registers or renews a Gmail push watch per mailbox (SPEC 3.2). Watches expire
 * after 7 days, so this runs daily and renews anything expiring within 48h.
 */
export async function renewWatches(): Promise<WatchResult> {
  if (!config.pubsub.topic) {
    logger.info('PUBSUB_TOPIC unset — running on polling only, no watches registered');
    return { renewed: 0, skipped: 0, failed: 0, reason: 'pubsub_not_configured' };
  }

  const gmail = getGmailClient();
  const mailboxes = await query<{ id: string; email: string; watch_expiration: Date | null }>(
    "SELECT id, email, watch_expiration FROM mailboxes WHERE status = 'active'",
  );

  const threshold = Date.now() + 48 * 3_600_000;
  let renewed = 0;
  let skipped = 0;
  let failed = 0;

  for (const mb of mailboxes) {
    if (mb.watch_expiration && mb.watch_expiration.getTime() > threshold) {
      skipped += 1;
      continue;
    }
    try {
      const res = await gmail.watch(mb.email, config.pubsub.topic);
      if (!res) { skipped += 1; continue; }
      await query(
        `UPDATE mailboxes SET watch_expiration = $2,
                              last_history_id = COALESCE(last_history_id, $3),
                              updated_at = now()
          WHERE id = $1`,
        [mb.id, new Date(res.expirationMs), res.historyId],
      );
      renewed += 1;
    } catch (err) {
      failed += 1;
      logger.error({ mailbox: mb.email, err }, 'watch renewal failed');
    }
  }

  logger.info({ renewed, skipped, failed }, 'watch renewal complete');
  return { renewed, skipped, failed };
}

/** Stops watching a mailbox that has gone inactive. */
export async function stopWatch(email: string): Promise<void> {
  try {
    await getGmailClient().stopWatch(email);
  } catch (err) {
    logger.warn({ email, err }, 'stopWatch failed');
  }
}
