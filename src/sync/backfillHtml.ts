import { query, tx } from '../db/pool.js';
import { getGmailClient } from '../gmail/index.js';
import { logger } from '../lib/logger.js';
import type { RawMessage } from '../gmail/types.js';

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
/** Same shape as the ingest path, so a backfilled message matches a fresh one. */
async function storeParts(c: any, messageId: number, raw: RawMessage): Promise<void> {
  for (const a of raw.attachments ?? []) {
    await c.query(
      `INSERT INTO attachments (message_id, filename, mime_type, size_bytes,
                                gmail_attachment_id, content_id, is_inline, part_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (message_id, COALESCE(part_id, ''), COALESCE(filename, '')) DO UPDATE SET
         gmail_attachment_id = COALESCE(EXCLUDED.gmail_attachment_id, attachments.gmail_attachment_id)`,
      [messageId, a.filename, a.mimeType, a.size, a.attachmentId ?? null, a.contentId ?? null, a.isInline ?? false, a.partId ?? null],
    );
  }
}

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
      WHERE (m.body_html IS NULL
             OR NOT EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id))
        AND m.attachments_checked_at IS NULL
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
        // Genuinely text-only. Mark it so the next pass skips it, but keep
        // any attachments it carries.
        await tx(async (c) => {
          await c.query("UPDATE messages SET body_html = '', attachments_checked_at = now() WHERE id = $1", [row.id]);
          if (raw) await storeParts(c, Number(row.id), raw);
        });
        noHtmlPart += 1;
        continue;
      }
      await tx(async (c) => {
        await c.query('UPDATE messages SET body_html = $2, attachments_checked_at = now() WHERE id = $1', [row.id, raw.bodyHtml]);
        await storeParts(c, Number(row.id), raw);
      });
      updated += 1;
    } catch (err) {
      failed += 1;
      logger.warn({ messageId: row.id, err }, 'could not backfill html for a message');
    }
  }

  const left = await query<{ n: string }>(
    'SELECT count(*)::int AS n FROM messages WHERE attachments_checked_at IS NULL',
  );

  const result = { scanned: rows.length, updated, noHtmlPart, failed, remaining: Number(left[0]?.n ?? 0) };
  logger.info(result, 'html backfill pass complete');
  return result;
}
