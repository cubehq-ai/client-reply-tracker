import { query } from '../db/pool.js';
import { getGmailClient } from '../gmail/index.js';
import { logger } from '../lib/logger.js';

export interface BackfillHtmlResult {
  scanned: number;
  updated: number;
  noHtmlPart: number;
  failed: number;
  remaining: number;
}

/**
 * Fetches the HTML part for messages stored before that column existed.
 *
 * Incremental sync only ever reads messages Gmail reports as new, so an
 * existing row is never revisited and would keep rendering the text/plain
 * alternative forever. Safe to re-run; it only touches rows still missing it.
 */
export async function backfillHtml(limit = 400): Promise<BackfillHtmlResult> {
  const gmail = getGmailClient();

  const rows = await query<{ id: string; gmail_message_id: string; email: string }>(
    `SELECT m.id, mc.gmail_message_id, mb.email
       FROM messages m
       JOIN LATERAL (
         SELECT gmail_message_id, mailbox_id FROM message_copies
          WHERE message_id = m.id AND deleted = false
          LIMIT 1
       ) mc ON true
       JOIN mailboxes mb ON mb.id = mc.mailbox_id
      WHERE m.body_html IS NULL
        AND mb.status = 'active'
      ORDER BY m.internal_date DESC
      LIMIT $1`,
    [limit],
  );

  let updated = 0;
  let noHtmlPart = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const raw = await gmail.getMessage(row.email, row.gmail_message_id, { withBody: true });
      if (!raw?.bodyHtml) {
        // Genuinely text-only. Mark it so the next pass skips it.
        await query("UPDATE messages SET body_html = '' WHERE id = $1", [row.id]);
        noHtmlPart += 1;
        continue;
      }
      await query('UPDATE messages SET body_html = $2 WHERE id = $1', [row.id, raw.bodyHtml]);
      updated += 1;
    } catch (err) {
      failed += 1;
      logger.warn({ messageId: row.id, err }, 'could not backfill html for a message');
    }
  }

  const left = await query<{ n: string }>(
    "SELECT count(*)::int AS n FROM messages WHERE body_html IS NULL",
  );

  const result = { scanned: rows.length, updated, noHtmlPart, failed, remaining: Number(left[0]?.n ?? 0) };
  logger.info(result, 'html backfill pass complete');
  return result;
}
