import { one, query } from '../db/pool.js';
import { getGmailClient } from '../gmail/index.js';
import { HttpError, type SessionUser } from './auth.js';
import { audit } from './actions.js';

export interface AttachmentRow {
  id: number;
  filename: string;
  mimeType: string;
  size: number;
  isInline: boolean;
  contentId: string | null;
}

/** Attachments on one message, for listing under it. */
export async function listAttachments(messageIds: number[]): Promise<Map<number, AttachmentRow[]>> {
  if (messageIds.length === 0) return new Map();
  const rows = await query<any>(
    `SELECT id, message_id, filename, mime_type, size_bytes, is_inline, content_id
       FROM attachments WHERE message_id = ANY($1::bigint[])
      ORDER BY is_inline, filename`,
    [messageIds],
  );
  const out = new Map<number, AttachmentRow[]>();
  for (const r of rows) {
    const list = out.get(Number(r.message_id)) ?? [];
    list.push({
      id: Number(r.id),
      filename: r.filename,
      mimeType: r.mime_type,
      size: Number(r.size_bytes ?? 0),
      isInline: r.is_inline,
      contentId: r.content_id,
    });
    out.set(Number(r.message_id), list);
  }
  return out;
}

export interface FetchedAttachment {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

/**
 * Streams one attachment straight from Gmail. Nothing is stored locally: the
 * bytes stay in the mailbox, and this reads them with the same delegation the
 * sync already uses.
 */
export async function fetchAttachment(user: SessionUser, attachmentId: number): Promise<FetchedAttachment> {
  const row = await one<any>(
    `SELECT a.filename, a.mime_type, a.gmail_attachment_id,
            mc.gmail_message_id, mb.email AS mailbox
       FROM attachments a
       JOIN messages m ON m.id = a.message_id
       JOIN LATERAL (
         SELECT gmail_message_id, mailbox_id FROM message_copies
          WHERE message_id = m.id AND deleted = false LIMIT 1
       ) mc ON true
       JOIN mailboxes mb ON mb.id = mc.mailbox_id
      WHERE a.id = $1`,
    [attachmentId],
  );
  if (!row) throw new HttpError(404, 'attachment not found');
  if (!row.gmail_attachment_id) throw new HttpError(409, 'this part has no downloadable body');

  const bytes = await getGmailClient().getAttachment(row.mailbox, row.gmail_message_id, row.gmail_attachment_id);
  if (!bytes) throw new HttpError(404, 'Gmail no longer has this attachment');

  // Reading a client's file is worth a record (SPEC 11).
  await audit(user, 'download_attachment', null, { attachmentId, filename: row.filename });

  return { filename: row.filename, mimeType: row.mime_type ?? 'application/octet-stream', bytes };
}
