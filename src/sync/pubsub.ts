import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { loadOrgContext } from '../pipeline/context.js';
import { syncMailbox, type MailboxRow } from './mailboxSync.js';

export interface PubSubPush {
  message?: { data?: string; messageId?: string; publishTime?: string };
  subscription?: string;
}

export interface PushResult {
  handled: boolean;
  mailbox?: string;
  reason?: string;
  ingested?: number;
}

/**
 * Handles one Gmail push notification (SPEC 3.2). The payload only says
 * "mailbox X changed, historyId N" — the actual messages come from
 * history.list, which syncMailbox already does.
 */
export async function handlePubSubPush(body: PubSubPush): Promise<PushResult> {
  const data = body?.message?.data;
  if (!data) return { handled: false, reason: 'no message data' };

  let payload: { emailAddress?: string; historyId?: number };
  try {
    payload = JSON.parse(Buffer.from(data, 'base64').toString('utf8'));
  } catch {
    return { handled: false, reason: 'unparseable payload' };
  }

  const email = payload.emailAddress?.toLowerCase();
  if (!email) return { handled: false, reason: 'no emailAddress' };

  const rows = await query<MailboxRow & { status: string }>(
    'SELECT id, email, last_history_id, backfilled_at, status FROM mailboxes WHERE email = $1',
    [email],
  );
  const mailbox = rows[0];
  if (!mailbox) return { handled: false, mailbox: email, reason: 'unknown mailbox' };
  if (mailbox.status !== 'active') return { handled: false, mailbox: email, reason: `mailbox is ${mailbox.status}` };

  const ctx = await loadOrgContext();
  const stats = await syncMailbox(mailbox, ctx);
  logger.info({ mailbox: email, ingested: stats.ingested }, 'handled pub/sub push');
  return { handled: true, mailbox: email, ingested: stats.ingested };
}
