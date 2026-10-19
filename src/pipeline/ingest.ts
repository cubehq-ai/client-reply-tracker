import type { PoolClient } from 'pg';
import { tx, query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import type { RawMessage } from '../gmail/types.js';
import { classifyMessage } from './classify.js';
import { matchClient } from './clientMatch.js';
import { resolveConversation } from './conversations.js';
import type { OrgContext } from './context.js';
import { triage } from './triage.js';
import { recordSentRecipients } from './contacted.js';
import { normalize, type NormalizedMessage } from './normalize.js';
import { resolveOwnership, userIdForEmail } from './ownership.js';
import { evaluateRules, recordRuleMatches } from './rules.js';
import { recomputeItemState, type ItemState } from './stateMachine.js';
import { config } from '../lib/config.js';

export interface IngestResult {
  skipped: boolean;
  reason?: string;
  conversationId?: number;
  itemId?: number;
  state?: ItemState;
  /** True when this exact RFC message was already stored from another mailbox. */
  duplicate?: boolean;
}

/**
 * Runs one message through the whole pipeline (SPEC 4).
 *
 * Writes happen in two short transactions with the classifier call in between,
 * so a model call never holds a database transaction open.
 */
export async function ingestMessage(raw: RawMessage, mailbox: string, ctx: OrgContext): Promise<IngestResult> {
  const msg = normalize(raw, mailbox);

  if (ctx.excludedMailboxes.has(msg.mailbox)) {
    return { skipped: true, reason: 'excluded_mailbox' };
  }
  if (msg.labels.some((l) => ctx.excludedLabels.has(l.toUpperCase()))) {
    return { skipped: true, reason: 'excluded_label' };
  }

  const mailboxId = await mailboxIdFor(msg.mailbox);
  if (mailboxId === null) return { skipped: true, reason: 'unknown_mailbox' };

  const senderInternal = ctx.isInternal(msg.fromEmail);
  const allParticipants = [msg.fromEmail, ...msg.to, ...msg.cc].filter(Boolean);
  const externalParticipants = [...new Set(allParticipants.filter((e) => !ctx.isInternal(e)))];

  // Internal-only thread: out of scope for v1 (SPEC 4 step 2).
  if (senderInternal && externalParticipants.length === 0 && msg.references.length === 0 && !msg.inReplyTo) {
    return { skipped: true, reason: 'internal_only' };
  }

  // --- Phase A: store the message and attach it to a conversation.
  const stored = await tx(async (c) => {
    const conv = await resolveConversation(c, msg, ctx.orgDomains);
    const { messageId, duplicate } = await upsertMessage(c, msg, conv.id, senderInternal, ctx);
    await attachCopy(c, messageId, mailboxId, msg);
    await storeAttachments(c, messageId, msg);
    await updateConversationRollup(c, conv.id, msg, senderInternal, externalParticipants);
    return { conversationId: conv.id, messageId, duplicate };
  });

  // An internal message is a potential reply event, never a new item (SPEC 4 step 2).
  if (senderInternal) {
    const result = await tx(async (c) => {
      // Our own outbound mail is what builds the prior-contact index.
      if (!msg.isDraft) {
        await recordSentRecipients(c, [...msg.to, ...msg.cc, ...msg.bcc], msg.internalDate, (e) => ctx.isInternal(e), ctx.clients.freeDomains);
      }
      return recomputeItemState(c, stored.conversationId);
    });
    return { skipped: false, reason: 'internal_reply_event', conversationId: stored.conversationId, state: result?.state, duplicate: stored.duplicate };
  }

  // --- User-authored rules run first: they can name the client, force a
  // message through the filters, or filter it out on their own terms.
  const ruleVerdict = evaluateRules(ctx.matchRules, msg);
  if (ruleVerdict.matchedRuleIds.length) void recordRuleMatches(ruleVerdict.matchedRuleIds);

  const match = ruleVerdict.clientId !== null
    ? { clientId: ruleVerdict.clientId, matchedOn: 'rule' as const, matchedValue: null }
    : matchClient(ctx.clients, msg.fromEmail, externalParticipants.filter((e) => e !== msg.fromEmail));

  // --- Triage: client mail, then bulk, then prior-contact (override 2).
  let verdict = triage(msg, match, {
    isClient: match.clientId !== null,
    blockedSenders: ctx.blockedSenders,
    blockedDomains: ctx.blockedDomains,
    contacts: ctx.contacts,
  });

  // A rule can override the triage outcome in either direction.
  if (ruleVerdict.ignoreReason) {
    verdict = { ...verdict, classify: false, reason: 'filtered', filterReason: ruleVerdict.ignoreReason };
  } else if (ruleVerdict.allowed && verdict.reason === 'filtered') {
    verdict = { ...verdict, classify: true, reason: null, filterReason: null };
  }

  await query('UPDATE messages SET filter_reason = $2, is_auto = $3, is_bounce = $4 WHERE id = $1', [
    stored.messageId, verdict.filterReason, verdict.filterReason !== null, verdict.filterReason === 'bounce',
  ]);

  // --- Phase B: classify, unless filtered out. Never pay for a filtered message (SPEC 13).
  let classification = null as Awaited<ReturnType<typeof classifyMessage>> | null;
  if (verdict.classify && !stored.duplicate) {
    const lastInternal = await query<{ body_text_trunc: string | null }>(
      `SELECT body_text_trunc FROM messages
        WHERE conversation_id = $1 AND direction = 'out' AND is_draft = false
        ORDER BY internal_date DESC LIMIT 1`,
      [stored.conversationId],
    );
    const clientName = match.clientId ? await clientNameFor(match.clientId) : undefined;
    classification = await classifyMessage(msg.rfcMessageId, {
      subject: msg.subject,
      body: msg.cleanedBody || msg.snippet,
      lastInternalBody: lastInternal[0]?.body_text_trunc ?? undefined,
      fromName: msg.fromName || msg.fromEmail,
      clientName,
    });
  }

  // --- Phase C: create or update the item and recompute state.
  const ownership = resolveOwnership({
    to: msg.to,
    cc: msg.cc,
    recipientMailboxes: [msg.mailbox],
    isInternal: (e) => ctx.isInternal(e),
    isSharedInbox: (e) => ctx.isSharedInbox(e),
    accountManagerEmail: match.clientId ? (ctx.accountManagerByClient.get(match.clientId) ?? null) : null,
  });
  const ownerUserId = await userIdForEmail(ownership.ownerEmail);

  const final = await tx(async (c) => {
    const closed = verdict.reason === 'filtered' || (classification !== null && !classification.needsReply);
    const initialState: ItemState = closed ? 'no_reply_needed' : 'needs_reply';
    const reason = verdict.reason === 'filtered' ? 'filtered' : closed ? 'not_needed' : null;
    // When a message is a duplicate we do not re-classify, so there is no
    // fresh verdict. Falling back to `false` would clear a flag the stored
    // confidence still justifies, so leave it to the COALESCE below.
    const lowConfidence =
      classification !== null ? classification.confidence < config.classifier.threshold : null;

    const itemRes = await c.query<{ id: string }>(
      `INSERT INTO items (conversation_id, source, state, reason, client_id, owner_user_id, watchers,
                          needs_reply_confidence, summary, filter_reason, last_external_at,
                          low_confidence, unmatched_client)
       VALUES ($1,'gmail',$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11, false),$12)
       ON CONFLICT (conversation_id) DO UPDATE SET
         client_id      = COALESCE(items.client_id, EXCLUDED.client_id),
         owner_user_id  = COALESCE(items.owner_user_id, EXCLUDED.owner_user_id),
         watchers       = ARRAY(SELECT DISTINCT unnest(items.watchers || EXCLUDED.watchers)),
         needs_reply_confidence = COALESCE(EXCLUDED.needs_reply_confidence, items.needs_reply_confidence),
         summary        = COALESCE(EXCLUDED.summary, items.summary),
         -- $11, not EXCLUDED: the VALUES clause already defaulted null to
         -- false, so EXCLUDED can never carry "no new verdict".
         low_confidence = COALESCE($11, items.low_confidence),
         unmatched_client = EXCLUDED.unmatched_client,
         updated_at     = now()
       RETURNING id`,
      [
        stored.conversationId,
        initialState,
        reason,
        match.clientId,
        ownerUserId,
        ownership.watchers,
        classification?.confidence ?? null,
        classification?.summary ?? msg.subject.slice(0, 300),
        verdict.filterReason,
        msg.internalDate,
        lowConfidence,
        verdict.unmatchedClient,
      ],
    );
    const itemId = Number(itemRes.rows[0]!.id);

    await c.query('UPDATE conversations SET client_id = COALESCE(client_id, $2) WHERE id = $1', [stored.conversationId, match.clientId]);

    const result = await recomputeItemState(c, stored.conversationId, {
      newestExternalNeedsReply: classification?.needsReply,
    });
    return { itemId, state: result?.state ?? initialState };
  });

  logger.debug(
    { mailbox: msg.mailbox, from: msg.fromEmail, state: final.state, branch: verdict.branch, client: match.clientId },
    'ingested message',
  );

  return {
    skipped: false,
    conversationId: stored.conversationId,
    itemId: final.itemId,
    state: final.state,
    duplicate: stored.duplicate,
  };
}

async function upsertMessage(
  c: PoolClient,
  msg: NormalizedMessage,
  conversationId: number,
  senderInternal: boolean,
  _ctx: OrgContext,
): Promise<{ messageId: number; duplicate: boolean }> {
  const res = await c.query<{ id: string }>(
    `INSERT INTO messages (conversation_id, rfc_message_id, from_email, from_domain, to_emails, cc_emails,
                           subject, internal_date, direction, snippet, body_text_trunc, in_reply_to,
                           references_ids, is_draft, bcc_emails, body_html)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (rfc_message_id) DO UPDATE SET
       -- Backfill only: fills a column added after the message was stored,
       -- and never overwrites a body we already have.
       body_html = COALESCE(messages.body_html, EXCLUDED.body_html),
       bcc_emails = CASE WHEN messages.bcc_emails = '{}' THEN EXCLUDED.bcc_emails ELSE messages.bcc_emails END
     RETURNING id, (xmax = 0) AS inserted`,
    [
      conversationId, msg.rfcMessageId, msg.fromEmail, msg.fromDomain, msg.to, msg.cc,
      msg.subject, msg.internalDate, senderInternal ? 'out' : 'in', msg.snippet,
      msg.bodyText, msg.inReplyTo, msg.references, msg.isDraft, msg.bcc, msg.bodyHtml,
    ],
  );

  const row = res.rows[0]!;
  // Not inserted means it was already stored, here or from another mailbox.
  return { messageId: Number(row.id), duplicate: !(row as any).inserted };
}

/** Attachment metadata only; the bytes stay in Gmail and stream on demand. */
async function storeAttachments(c: PoolClient, messageId: number, msg: NormalizedMessage): Promise<void> {
  for (const a of msg.attachments) {
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

async function attachCopy(c: PoolClient, messageId: number, mailboxId: number, msg: NormalizedMessage): Promise<void> {
  await c.query(
    `INSERT INTO message_copies (message_id, mailbox_id, gmail_message_id, gmail_thread_id, labels)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (mailbox_id, gmail_message_id) DO UPDATE SET labels = EXCLUDED.labels, deleted = false`,
    [messageId, mailboxId, msg.gmailMessageId, msg.gmailThreadId, msg.labels],
  );
}

async function updateConversationRollup(
  c: PoolClient,
  conversationId: number,
  msg: NormalizedMessage,
  senderInternal: boolean,
  externalParticipants: string[],
): Promise<void> {
  await c.query(
    `UPDATE conversations SET
       -- Keep the subject of the earliest external message: a later internal
       -- "Fwd: ..." must not rename the thread.
       subject = CASE
                   WHEN subject IS NULL OR subject = '' THEN $2
                   WHEN $4 THEN subject
                   WHEN first_external_at IS NULL OR $5 < first_external_at THEN $2
                   ELSE subject
                 END,
       participants_ext = ARRAY(SELECT DISTINCT unnest(participants_ext || $3::text[])),
       first_external_at = CASE WHEN $4 THEN first_external_at ELSE LEAST(COALESCE(first_external_at, $5), $5) END,
       last_external_at  = CASE WHEN $4 THEN last_external_at  ELSE GREATEST(COALESCE(last_external_at, $5), $5) END,
       last_internal_at  = CASE WHEN $4 THEN GREATEST(COALESCE(last_internal_at, $5), $5) ELSE last_internal_at END,
       updated_at = now()
     WHERE id = $1`,
    [conversationId, msg.subject, externalParticipants, senderInternal, msg.internalDate],
  );
}

const mailboxIdCache = new Map<string, number>();

export async function mailboxIdFor(email: string): Promise<number | null> {
  const key = email.toLowerCase();
  const cached = mailboxIdCache.get(key);
  if (cached !== undefined) return cached;
  const rows = await query<{ id: string }>('SELECT id FROM mailboxes WHERE email = $1', [key]);
  if (!rows[0]) return null;
  const id = Number(rows[0].id);
  mailboxIdCache.set(key, id);
  return id;
}

export function clearMailboxCache(): void {
  mailboxIdCache.clear();
}

async function clientNameFor(clientId: number): Promise<string | undefined> {
  const rows = await query<{ name: string }>('SELECT name FROM clients WHERE id = $1', [clientId]);
  return rows[0]?.name;
}
