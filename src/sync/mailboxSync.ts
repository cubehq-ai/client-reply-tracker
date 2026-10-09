import { query, tx } from '../db/pool.js';
import { getGmailClient } from '../gmail/index.js';
import type { GmailClient, RawMessage } from '../gmail/types.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { loadOrgContext, type OrgContext } from '../pipeline/context.js';
import { ingestMessage } from '../pipeline/ingest.js';
import { recomputeItemState } from '../pipeline/stateMachine.js';

/** Gmail query used for backfill and resync (SPEC 3.2). */
export const BASE_QUERY = '-in:chats -in:spam -in:trash';

export interface MailboxRow {
  id: string;
  email: string;
  last_history_id: string | null;
  backfilled_at: Date | null;
}

export interface SyncStats {
  mailbox: string;
  fetched: number;
  ingested: number;
  skipped: number;
  duplicates: number;
  errors: number;
  mode: 'backfill' | 'history' | 'resync' | 'skipped';
}

export async function activeMailboxes(): Promise<MailboxRow[]> {
  return query<MailboxRow>(
    "SELECT id, email, last_history_id, backfilled_at FROM mailboxes WHERE status = 'active' ORDER BY email",
  );
}

/**
 * Syncs one mailbox. Backfills on first contact, otherwise walks history from
 * the saved id, falling back to a full resync when Gmail says that id has aged
 * out (SPEC 3.2).
 */
export async function syncMailbox(
  mailbox: MailboxRow,
  ctx: OrgContext,
  gmail: GmailClient = getGmailClient(),
): Promise<SyncStats> {
  const stats: SyncStats = { mailbox: mailbox.email, fetched: 0, ingested: 0, skipped: 0, duplicates: 0, errors: 0, mode: 'history' };

  if (ctx.excludedMailboxes.has(mailbox.email.toLowerCase())) {
    return { ...stats, mode: 'skipped' };
  }

  let messageIds: { id: string; threadId: string }[] = [];
  let newHistoryId: string | null = null;

  if (!mailbox.backfilled_at || !mailbox.last_history_id) {
    stats.mode = 'backfill';
    // Anchor the history cursor BEFORE listing, so messages arriving during
    // the backfill are picked up by the next incremental run rather than lost.
    newHistoryId = await gmail.getProfileHistoryId(mailbox.email);
    messageIds = await gmail.listMessageIds(mailbox.email, `${BASE_QUERY} newer_than:${config.org.backfillDays}d`);
  } else {
    const page = await gmail.listHistory(mailbox.email, mailbox.last_history_id);
    if (page.expired) {
      stats.mode = 'resync';
      logger.warn({ mailbox: mailbox.email }, 'historyId too old, falling back to a full resync');
      newHistoryId = await gmail.getProfileHistoryId(mailbox.email);
      messageIds = await gmail.listMessageIds(mailbox.email, `${BASE_QUERY} newer_than:${config.org.backfillDays}d`);
    } else {
      messageIds = page.messageIds;
      newHistoryId = page.historyId;
      if (page.deletedIds.length) await markCopiesDeleted(Number(mailbox.id), page.deletedIds);
    }
  }

  // Fetch first, then ingest oldest-first. Order matters: the state machine
  // replays history, so ingesting a thread newest-first would never observe
  // the replied -> reopened transition and would undercount reopens.
  const fetched: RawMessage[] = [];
  for (const { id } of messageIds) {
    try {
      // Bodies are needed for classification; metadata alone is not enough.
      const raw = await gmail.getMessage(mailbox.email, id, { withBody: true });
      if (!raw) continue;
      fetched.push(raw);
      stats.fetched += 1;
    } catch (err) {
      stats.errors += 1;
      logger.error({ mailbox: mailbox.email, messageId: id, err }, 'failed to fetch message');
    }
  }
  fetched.sort((a, b) => a.internalDateMs - b.internalDateMs);

  for (const raw of fetched) {
    try {
      const result = await ingestMessage(raw, mailbox.email, ctx);
      if (result.skipped) stats.skipped += 1;
      else stats.ingested += 1;
      if (result.duplicate) stats.duplicates += 1;
    } catch (err) {
      stats.errors += 1;
      logger.error({ mailbox: mailbox.email, messageId: raw.id, err }, 'failed to ingest message');
    }
  }

  await query(
    `UPDATE mailboxes SET last_history_id = COALESCE($2, last_history_id),
                          last_synced_at = now(),
                          backfilled_at = COALESCE(backfilled_at, now()),
                          last_error = NULL,
                          updated_at = now()
      WHERE id = $1`,
    [mailbox.id, newHistoryId],
  );

  return stats;
}

async function markCopiesDeleted(mailboxId: number, gmailMessageIds: string[]): Promise<void> {
  await tx(async (c) => {
    const affected = await c.query<{ conversation_id: string }>(
      `UPDATE message_copies mc SET deleted = true
         FROM messages m
        WHERE mc.message_id = m.id
          AND mc.mailbox_id = $1
          AND mc.gmail_message_id = ANY($2::text[])
      RETURNING m.conversation_id`,
      [mailboxId, gmailMessageIds],
    );
    // A thread deleted in one mailbox but alive in another stays open (SPEC 12).
    for (const id of new Set(affected.rows.map((r) => Number(r.conversation_id)))) {
      await recomputeItemState(c, id);
    }
  });
}

export interface SyncAllResult {
  mailboxes: number;
  stats: SyncStats[];
  totalIngested: number;
}

export async function syncAllMailboxes(): Promise<SyncAllResult> {
  const ctx = await loadOrgContext();
  const boxes = await activeMailboxes();
  const stats: SyncStats[] = [];
  for (const mb of boxes) {
    try {
      stats.push(await syncMailbox(mb, ctx));
    } catch (err) {
      logger.error({ mailbox: mb.email, err }, 'mailbox sync failed');
      await query('UPDATE mailboxes SET last_error = $2, updated_at = now() WHERE id = $1', [mb.id, String(err)]);
      stats.push({ mailbox: mb.email, fetched: 0, ingested: 0, skipped: 0, duplicates: 0, errors: 1, mode: 'history' });
    }
  }
  const totalIngested = stats.reduce((n, s) => n + s.ingested, 0);
  logger.info({ mailboxes: boxes.length, totalIngested }, 'sync pass complete');
  return { mailboxes: boxes.length, stats, totalIngested };
}

/**
 * Re-checks a single conversation against Gmail before the composer opens, so
 * two people do not reply to the same mail (SPEC 6).
 */
export async function refreshConversation(conversationId: number): Promise<void> {
  const ctx = await loadOrgContext();
  const gmail = getGmailClient();
  const copies = await query<{ email: string; gmail_thread_id: string }>(
    `SELECT DISTINCT mb.email, mc.gmail_thread_id
       FROM message_copies mc
       JOIN messages m ON m.id = mc.message_id
       JOIN mailboxes mb ON mb.id = mc.mailbox_id
      WHERE m.conversation_id = $1 AND mc.deleted = false AND mb.status = 'active'`,
    [conversationId],
  );

  for (const copy of copies) {
    try {
      const messages = await gmail.getThreadMessages(copy.email, copy.gmail_thread_id);
      for (const raw of messages) await ingestMessage(raw, copy.email, ctx);
    } catch (err) {
      logger.warn({ conversationId, mailbox: copy.email, err }, 'conversation refresh failed');
    }
  }
  await tx((c) => recomputeItemState(c, conversationId));
}
