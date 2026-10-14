import { randomBytes } from 'node:crypto';
import { one, query } from '../db/pool.js';
import { getGmailClient } from '../gmail/index.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { getLlmClient } from '../llm/index.js';
import { loadOrgContext } from '../pipeline/context.js';
import { normalizeSubject } from '../pipeline/normalize.js';
import { refreshConversation } from '../sync/mailboxSync.js';
import { audit } from './actions.js';
import { HttpError, type SessionUser } from './auth.js';

export interface ThreadMessage {
  id: number;
  rfcMessageId: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  date: string;
  direction: 'in' | 'out';
  body: string;
  snippet: string;
  isDraft: boolean;
  filterReason: string | null;
}

export interface ThreadView {
  itemId: number;
  conversationId: number;
  subject: string;
  state: string;
  clientName: string | null;
  messages: ThreadMessage[];
  reply: {
    to: string[];
    cc: string[];
    subject: string;
    inReplyTo: string | null;
    references: string[];
    /** The thread id in THIS user's mailbox, if they have the thread. */
    threadId: string | null;
    sendAs: string[];
  };
  lockedBy: string | null;
}

/**
 * Loads the full thread and the pre-filled reply (SPEC 9). Re-syncs the
 * conversation first so the composer never opens on stale state.
 */
export async function getThread(user: SessionUser, itemId: number, opts: { refresh?: boolean } = {}): Promise<ThreadView> {
  if (opts.refresh) {
    const target = await one<{ conversation_id: string }>('SELECT conversation_id FROM items WHERE id = $1', [itemId]);
    if (!target) throw new HttpError(404, 'item not found');
    try {
      await refreshConversation(Number(target.conversation_id));
    } catch (err) {
      logger.warn({ itemId, err }, 'pre-composer refresh failed; showing stored state');
    }
  }

  // Everything keys off the item id, so these run as one round trip rather
  // than a lookup followed by four dependent queries.
  const [itemRows, rows, ctx, ownThreadRows, lockRows, holders, otherMailboxes] = await Promise.all([
    query<any>(
      `SELECT i.*, c.subject, c.id AS conversation_id, cl.name AS client_name
         FROM items i JOIN conversations c ON c.id = i.conversation_id
         LEFT JOIN clients cl ON cl.id = i.client_id
        WHERE i.id = $1`,
      [itemId],
    ),
    query<any>(
      `SELECT m.id, m.rfc_message_id, m.from_email, m.to_emails, m.cc_emails, m.bcc_emails,
              m.subject, m.internal_date, m.direction, m.body_text_trunc, m.snippet,
              m.is_draft, m.filter_reason
         FROM messages m
         JOIN items i ON i.conversation_id = m.conversation_id
        WHERE i.id = $1
        ORDER BY m.internal_date ASC`,
      [itemId],
    ),
    loadOrgContext(),
    query<{ gmail_thread_id: string }>(
      `SELECT mc.gmail_thread_id FROM message_copies mc
         JOIN messages m ON m.id = mc.message_id
         JOIN items i ON i.conversation_id = m.conversation_id
         JOIN mailboxes mb ON mb.id = mc.mailbox_id
        WHERE i.id = $1 AND mb.email = $2 AND mc.deleted = false
        ORDER BY m.internal_date DESC LIMIT 1`,
      [itemId, user.email],
    ),
    query<{ user_email: string }>(
      'SELECT user_email FROM item_locks WHERE item_id = $1 AND expires_at > now()',
      [itemId],
    ),
    // Which of our mailboxes hold this thread, and (for an admin) every other
    // active mailbox. Both only need the item id and the role.
    query<{ email: string }>(
      `SELECT DISTINCT mb.email FROM message_copies mc
         JOIN messages m ON m.id = mc.message_id
         JOIN items i ON i.conversation_id = m.conversation_id
         JOIN mailboxes mb ON mb.id = mc.mailbox_id
        WHERE i.id = $1 AND mc.deleted = false AND mb.status = 'active'
        ORDER BY mb.email`,
      [itemId],
    ),
    user.role === 'admin'
      ? query<{ email: string }>("SELECT email FROM mailboxes WHERE status = 'active' ORDER BY kind DESC, email")
      : user.canSendAsShared
        ? query<{ email: string }>("SELECT email FROM mailboxes WHERE kind = 'shared' AND status = 'active'")
        : Promise.resolve([] as { email: string }[]),
  ]);

  const item = itemRows[0];
  if (!item) throw new HttpError(404, 'item not found');
  const ownThread = ownThreadRows[0] ?? null;
  const lock = lockRows[0] ?? null;

  const messages: ThreadMessage[] = rows.map((r) => ({
    id: Number(r.id),
    rfcMessageId: r.rfc_message_id,
    from: r.from_email,
    to: r.to_emails ?? [],
    cc: r.cc_emails ?? [],
    bcc: r.bcc_emails ?? [],
    subject: r.subject ?? '',
    date: r.internal_date.toISOString(),
    direction: r.direction,
    body: r.body_text_trunc ?? r.snippet ?? '',
    snippet: r.snippet ?? '',
    isDraft: r.is_draft,
    filterReason: r.filter_reason,
  }));

  const lastExternal = [...messages].reverse().find((m) => m.direction === 'in' && !m.isDraft);

  // Reply-all to the last external message, minus ourselves (SPEC 9).
  const to = lastExternal ? [lastExternal.from] : [];
  const cc = lastExternal
    ? [...new Set([...lastExternal.to, ...lastExternal.cc])].filter(
        (e) => e !== user.email && e !== lastExternal.from && !ctx.isSharedInbox(e),
      )
    : [];

  const references = [...new Set(messages.map((m) => m.rfcMessageId))];
  const baseSubject = normalizeSubject(item.subject ?? '');
  const replySubject = baseSubject ? `Re: ${item.subject.replace(/^((re|fwd?)\s*:\s*)+/i, '')}` : 'Re:';

  // Replying from a mailbox that already holds the thread keeps the
  // conversation in one place for the client, so those come first.
  const sendAs = [...new Set([...holders.map((h) => h.email), ...otherMailboxes.map((m) => m.email), user.email])];

  return {
    itemId: Number(item.id),
    conversationId: Number(item.conversation_id),
    subject: item.subject ?? '(no subject)',
    state: item.state,
    clientName: item.client_name,
    messages,
    reply: {
      to,
      cc,
      subject: replySubject,
      inReplyTo: lastExternal?.rfcMessageId ?? null,
      references,
      threadId: ownThread?.gmail_thread_id ?? null,
      sendAs: [...new Set(sendAs)],
    },
    lockedBy: lock?.user_email ?? null,
  };
}

export interface CollisionCheck {
  collision: boolean;
  repliedBy?: string;
  minutesAgo?: number;
}

/** Warns when someone else replied in the last few minutes (SPEC 9). */
export async function checkCollision(conversationId: number, windowMinutes = 10): Promise<CollisionCheck> {
  const row = await one<{ from_email: string; internal_date: Date }>(
    `SELECT from_email, internal_date FROM messages
      WHERE conversation_id = $1 AND direction = 'out' AND is_draft = false
        AND internal_date > now() - ($2 || ' minutes')::interval
      ORDER BY internal_date DESC LIMIT 1`,
    [conversationId, String(windowMinutes)],
  );
  if (!row) return { collision: false };
  return {
    collision: true,
    repliedBy: row.from_email,
    minutesAgo: Math.max(0, Math.round((Date.now() - row.internal_date.getTime()) / 60_000)),
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** RFC 2047 encoded-word, so non-ASCII subjects survive. */
function encodeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x20-\x7E]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export interface BuildMimeInput {
  from: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  bodyText: string;
  inReplyTo?: string | null;
  references?: string[];
  quoted?: { from: string; date: string; body: string } | null;
  messageId?: string;
}

/**
 * Builds a multipart/alternative reply that Gmail and Outlook will both thread
 * correctly: In-Reply-To plus the full References chain (SPEC 9).
 */
export function buildMime(input: BuildMimeInput): string {
  const boundary = `----rq-${randomBytes(12).toString('hex')}`;
  const messageId = input.messageId ?? `<${randomBytes(16).toString('hex')}@${input.from.split('@')[1]}>`;

  const quotedText = input.quoted
    ? `\n\nOn ${input.quoted.date}, ${input.quoted.from} wrote:\n` +
      input.quoted.body.split('\n').map((l) => `> ${l}`).join('\n')
    : '';

  const text = `${input.bodyText}${quotedText}`;
  const html =
    `<div>${escapeHtml(input.bodyText).replace(/\n/g, '<br>')}</div>` +
    (input.quoted
      ? `<br><blockquote style="margin:0 0 0 .8ex;border-left:2px solid #ccc;padding-left:1ex">` +
        `<div>On ${escapeHtml(input.quoted.date)}, ${escapeHtml(input.quoted.from)} wrote:</div>` +
        `<div>${escapeHtml(input.quoted.body).replace(/\n/g, '<br>')}</div></blockquote>`
      : '');

  const headers = [
    `From: ${input.fromName ? `${encodeHeader(input.fromName)} <${input.from}>` : input.from}`,
    `To: ${input.to.join(', ')}`,
    ...(input.cc?.length ? [`Cc: ${input.cc.join(', ')}`] : []),
    // Gmail strips Bcc from the copies it delivers; it is kept on our own.
    ...(input.bcc?.length ? [`Bcc: ${input.bcc.join(', ')}`] : []),
    `Subject: ${encodeHeader(input.subject)}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    ...(input.inReplyTo ? [`In-Reply-To: ${input.inReplyTo}`] : []),
    ...(input.references?.length ? [`References: ${input.references.join(' ')}`] : []),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];

  return [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

export interface SendReplyInput {
  itemId: number;
  sendAs?: string;
  /**
   * Which message in the thread this answers. Threading headers are built
   * from it, so a reply to an older message lands under that message rather
   * than under whatever happened to arrive last.
   */
  replyToMessageId?: number;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  /** Set after the user accepted the collision warning. */
  force?: boolean;
  saveAsDraft?: boolean;
}

export interface SendReplyResult {
  state: string;
  dryRun: boolean;
  messageId?: string;
  draftId?: string;
  collision?: CollisionCheck;
}

export async function sendReply(user: SessionUser, input: SendReplyInput): Promise<SendReplyResult> {
  const thread = await getThread(user, input.itemId, { refresh: true });

  const sendAs = (input.sendAs ?? thread.reply.sendAs[0] ?? user.email).toLowerCase();
  if (sendAs !== user.email) {
    // The composer offers these, but the server decides (SPEC 9, 11).
    if (!thread.reply.sendAs.includes(sendAs)) {
      throw new HttpError(403, 'you may not send as that mailbox');
    }
    const ctx = await loadOrgContext();
    const isShared = ctx.isSharedInbox(sendAs);
    if (user.role !== 'admin' && !(isShared && user.canSendAsShared)) {
      throw new HttpError(403, 'you are not allowed to send as that mailbox');
    }
  }

  if (!input.force && !input.saveAsDraft) {
    const collision = await checkCollision(thread.conversationId);
    if (collision.collision && collision.repliedBy !== sendAs) {
      return { state: thread.state, dryRun: !config.safety.sendEnabled, collision };
    }
  }

  if (input.to.length === 0) throw new HttpError(400, 'at least one recipient is required');

  // Reply to the chosen message, falling back to the latest external one.
  const targetIndex = input.replyToMessageId
    ? thread.messages.findIndex((m) => m.id === input.replyToMessageId)
    : -1;
  const target =
    targetIndex >= 0
      ? thread.messages[targetIndex]
      : [...thread.messages].reverse().find((m) => m.direction === 'in' && !m.isDraft);

  if (input.replyToMessageId && targetIndex === -1) {
    throw new HttpError(400, 'the message being replied to is not part of this thread');
  }

  // References must be the chain up to the message being answered, not the
  // whole thread, or clients nest the reply in the wrong place.
  const upTo = targetIndex >= 0 ? thread.messages.slice(0, targetIndex + 1) : thread.messages;
  const references = [...new Set(upTo.map((m) => m.rfcMessageId))];

  const mime = buildMime({
    from: sendAs,
    fromName: user.name ?? undefined,
    to: input.to,
    cc: input.cc ?? [],
    bcc: input.bcc ?? [],
    subject: input.subject,
    bodyText: input.body,
    inReplyTo: target?.rfcMessageId ?? thread.reply.inReplyTo,
    references,
    quoted: target ? { from: target.from, date: new Date(target.date).toUTCString(), body: target.body } : null,
  });

  const gmail = getGmailClient();

  if (input.saveAsDraft) {
    const draft = await gmail.createDraft(sendAs, mime, thread.reply.threadId ?? undefined);
    await audit(user, 'save_draft', input.itemId, { sendAs, draftId: draft.id });
    return { state: thread.state, dryRun: !config.safety.sendEnabled, draftId: draft.id };
  }

  // There is no interim state: the item closes as `replied` only once sync
  // sees the sent message (override 1).
  await query('UPDATE items SET last_error = NULL, updated_at = now() WHERE id = $1', [input.itemId]);

  try {
    const result = await gmail.send(sendAs, mime, thread.reply.threadId ?? undefined);
    await audit(user, 'send_reply', input.itemId, {
      sendAs, to: input.to, cc: input.cc ?? [], bcc: input.bcc ?? [],
      gmailMessageId: result.id, rfcMessageId: result.rfcMessageId, dryRun: result.dryRun,
    });

    if (result.dryRun) {
      await query(
        `UPDATE items SET last_error = 'SEND_ENABLED=false — message logged, not sent', updated_at = now()
          WHERE id = $1`,
        [input.itemId],
      );
      return { state: 'needs_reply', dryRun: true, messageId: result.rfcMessageId };
    }

    await refreshConversation(thread.conversationId);
    const after = await one<{ state: string }>('SELECT state FROM items WHERE id = $1', [input.itemId]);
    return { state: after?.state ?? 'needs_reply', dryRun: false, messageId: result.rfcMessageId };
  } catch (err) {
    await query(
      `UPDATE items SET state = 'needs_reply', reason = NULL, last_error = $2, updated_at = now() WHERE id = $1`,
      [input.itemId, String(err)],
    );
    logger.error({ itemId: input.itemId, err }, 'send failed');
    throw new HttpError(502, `send failed: ${String(err)}`);
  }
}

/** AI draft (SPEC 9). Never auto-sends; the user always edits first. */
export async function draftReply(user: SessionUser, itemId: number): Promise<{ draft: string }> {
  const thread = await getThread(user, itemId);
  const draft = await getLlmClient().draftReply({
    subject: thread.subject,
    senderName: user.name ?? user.email,
    clientName: thread.clientName ?? undefined,
    thread: thread.messages
      .filter((m) => !m.isDraft)
      .slice(-8)
      .map((m) => ({ from: m.from, date: m.date, body: m.body, direction: m.direction })),
  });
  await audit(user, 'ai_draft', itemId, {});
  return { draft };
}
