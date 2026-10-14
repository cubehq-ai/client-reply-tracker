import { one, query, tx } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { recomputeItemState } from '../pipeline/stateMachine.js';
import { rematchUnmatchedItems } from '../sync/clients.js';
import { HttpError, requireRole, type SessionUser } from './auth.js';

export type IgnoreScope = 'message' | 'thread' | 'sender' | 'domain';
export const IGNORE_REASONS = ['not_needed', 'spam', 'not_a_client', 'other'] as const;
export type IgnoreReason = (typeof IGNORE_REASONS)[number];

async function loadItem(itemId: number): Promise<any> {
  const item = await one(
    `SELECT i.*, c.subject, c.global_key FROM items i JOIN conversations c ON c.id = i.conversation_id WHERE i.id = $1`,
    [itemId],
  );
  if (!item) throw new HttpError(404, 'item not found');
  return item;
}

export async function audit(user: SessionUser | null, action: string, itemId: number | null, payload: unknown): Promise<void> {
  await query('INSERT INTO audit_log (user_email, action, item_id, payload) VALUES ($1,$2,$3,$4)', [
    user?.email ?? null, action, itemId, JSON.stringify(payload ?? {}),
  ]);
}

async function recordEvent(itemId: number, from: string, to: string, event: string, actor: string, detail: unknown = {}): Promise<void> {
  await query('INSERT INTO item_events (item_id, from_state, to_state, event, actor, detail) VALUES ($1,$2,$3,$4,$5,$6)', [
    itemId, from, to, event, actor, JSON.stringify(detail ?? {}),
  ]);
}

/**
 * Ignore, with the four sub-choices from SPEC 5. Scope decides whether the
 * client can reopen the item by writing again, and whether a standing block
 * rule is created.
 */
export async function ignoreItem(
  user: SessionUser,
  itemId: number,
  reason: IgnoreReason,
  scope: IgnoreScope,
): Promise<{ state: string; ruleCreated: string | null }> {
  const item = await loadItem(itemId);
  if (!IGNORE_REASONS.includes(reason)) throw new HttpError(400, 'a reason is required');

  const sender = await one<{ from_email: string; from_domain: string }>(
    `SELECT from_email, from_domain FROM messages
      WHERE conversation_id = $1 AND direction = 'in' ORDER BY internal_date DESC LIMIT 1`,
    [item.conversation_id],
  );

  let ruleCreated: string | null = null;

  if (scope === 'domain') {
    // Blocking a client's whole domain hides every thread from them, so it is
    // an admin decision (SPEC 5).
    const isClientDomain = sender && (await one('SELECT 1 FROM client_domains WHERE domain = $1', [sender.from_domain]));
    if (isClientDomain) requireRole(user, ['admin']);
    if (sender) {
      await query(
        `INSERT INTO rules (type, value, created_by, scope) VALUES ('block_domain',$1,$2,'org')
         ON CONFLICT (type, value, scope, created_by) DO NOTHING`,
        [sender.from_domain, user.email],
      );
      ruleCreated = `block_domain:${sender.from_domain}`;
    }
  } else if (scope === 'sender' && sender) {
    await query(
      `INSERT INTO rules (type, value, created_by, scope) VALUES ('block_sender',$1,$2,'org')
       ON CONFLICT (type, value, scope, created_by) DO NOTHING`,
      [sender.from_email, user.email],
    );
    ruleCreated = `block_sender:${sender.from_email}`;
  }

  const muted = scope !== 'message';

  await query(
    `UPDATE items SET state = 'no_reply_needed', reason = 'ignored', ignore_reason = $2, muted = $3,
                      state_since = now(), acted_on_external_at = last_external_at, updated_at = now()
      WHERE id = $1`,
    [itemId, reason, muted],
  );
  await recordEvent(itemId, item.state, 'no_reply_needed', `ignored:${scope}`, user.email, { reason, scope });
  await audit(user, 'ignore', itemId, { reason, scope, ruleCreated });

  return { state: 'no_reply_needed', ruleCreated };
}

/** Undo within the 30-day window (SPEC 5). */
export async function undoIgnore(user: SessionUser, itemId: number): Promise<{ state: string }> {
  const item = await loadItem(itemId);
  if (item.reason !== 'ignored') throw new HttpError(409, 'item is not ignored');

  await query(
    `UPDATE items SET state = 'needs_reply', reason = NULL, ignore_reason = NULL, muted = false,
                      state_since = now(), acted_on_external_at = NULL, updated_at = now()
      WHERE id = $1`,
    [itemId],
  );
  // Recompute so a reply that landed meanwhile is still honoured.
  await tx((c) => recomputeItemState(c, Number(item.conversation_id)));
  await recordEvent(itemId, 'no_reply_needed', 'needs_reply', 'undo_ignore', user.email);
  await audit(user, 'undo_ignore', itemId, {});
  const after = await loadItem(itemId);
  return { state: after.state };
}

export async function reassignItem(user: SessionUser, itemId: number, ownerEmail: string): Promise<{ ownerEmail: string }> {
  const item = await loadItem(itemId);
  const owner = await one<{ id: string }>('SELECT id FROM users WHERE email = $1', [ownerEmail.toLowerCase()]);
  if (!owner) throw new HttpError(404, `no such user: ${ownerEmail}`);

  await query(
    `UPDATE items SET owner_user_id = $2,
                      watchers = ARRAY(SELECT DISTINCT unnest(watchers || ARRAY[$3::text])),
                      updated_at = now()
      WHERE id = $1`,
    [itemId, Number(owner.id), ownerEmail.toLowerCase()],
  );
  await recordEvent(itemId, item.state, item.state, 'reassigned', user.email, { to: ownerEmail });
  await audit(user, 'reassign', itemId, { to: ownerEmail });
  return { ownerEmail: ownerEmail.toLowerCase() };
}

/** "Needs reply" on a closed item. The disagreement trains the classifier. */
export async function markNeedsReply(user: SessionUser, itemId: number): Promise<{ state: string }> {
  const item = await loadItem(itemId);
  await query(
    `UPDATE items SET state = 'needs_reply', reason = NULL, muted = false,
                      state_since = now(), acted_on_external_at = NULL,
                      restored_from_filter = CASE WHEN reason = 'filtered' THEN true ELSE restored_from_filter END,
                      updated_at = now()
      WHERE id = $1`,
    [itemId],
  );
  await query(
    'INSERT INTO classifier_feedback (item_id, predicted, actual, confidence, user_email) VALUES ($1,$2,$3,$4,$5)',
    [itemId, item.reason ?? item.state, 'needs_reply', item.needs_reply_confidence, user.email],
  );
  await recordEvent(itemId, item.state, 'needs_reply', 'user_marked_needs_reply', user.email, { from: item.reason });
  await audit(user, 'mark_needs_reply', itemId, { from: item.reason });
  return { state: 'needs_reply' };
}

/** "No reply needed" on an open item. Also logged as classifier feedback. */
export async function markNoReplyNeeded(user: SessionUser, itemId: number): Promise<{ state: string }> {
  const item = await loadItem(itemId);
  await query(
    `UPDATE items SET state = 'no_reply_needed', reason = 'not_needed',
                      state_since = now(), acted_on_external_at = last_external_at, updated_at = now()
      WHERE id = $1`,
    [itemId],
  );
  await query(
    'INSERT INTO classifier_feedback (item_id, predicted, actual, confidence, user_email) VALUES ($1,$2,$3,$4,$5)',
    [itemId, 'needs_reply', 'not_needed', item.needs_reply_confidence, user.email],
  );
  await recordEvent(itemId, item.state, 'no_reply_needed', 'user_marked_not_needed', user.email);
  await audit(user, 'mark_no_reply_needed', itemId, {});
  return { state: 'no_reply_needed' };
}

/** Links an unmatched sender to a client, retroactively (SPEC 4 step 4). */
export async function linkToClient(
  user: SessionUser,
  itemId: number,
  clientId: number,
  mode: 'email' | 'domain',
): Promise<{ linked: string; rematched: number }> {
  const item = await loadItem(itemId);
  const sender = await one<{ from_email: string; from_domain: string }>(
    `SELECT from_email, from_domain FROM messages
      WHERE conversation_id = $1 AND direction = 'in' ORDER BY internal_date DESC LIMIT 1`,
    [item.conversation_id],
  );
  if (!sender) throw new HttpError(409, 'no external message on this conversation');

  if (mode === 'domain') {
    const free = await one('SELECT 1 FROM free_email_domains WHERE domain = $1', [sender.from_domain]);
    // Mapping gmail.com to a client would claim every personal address on it.
    if (free) throw new HttpError(400, `${sender.from_domain} is a free email provider; link the address instead`);
    await query(
      `INSERT INTO client_domains (client_id, domain, source) VALUES ($1,$2,'manual')
       ON CONFLICT (domain) DO UPDATE SET client_id = EXCLUDED.client_id`,
      [clientId, sender.from_domain],
    );
  } else {
    await query(
      `INSERT INTO client_contacts (client_id, email, source) VALUES ($1,$2,'manual')
       ON CONFLICT (email) DO UPDATE SET client_id = EXCLUDED.client_id`,
      [clientId, sender.from_email],
    );
  }

  const rematched = await rematchUnmatchedItems();
  await audit(user, 'link_to_client', itemId, { clientId, mode, value: mode === 'domain' ? sender.from_domain : sender.from_email });
  logger.info({ itemId, clientId, mode, rematched }, 'linked sender to client');
  return { linked: mode === 'domain' ? sender.from_domain : sender.from_email, rematched };
}

/** Soft composer lock so two people do not draft the same reply (SPEC 9). */
export async function acquireLock(user: SessionUser, itemId: number): Promise<{ lockedBy: string; mine: boolean }> {
  const existing = await one<{ user_email: string }>(
    'SELECT user_email FROM item_locks WHERE item_id = $1 AND expires_at > now()',
    [itemId],
  );
  if (existing && existing.user_email !== user.email) {
    return { lockedBy: existing.user_email, mine: false };
  }
  await query(
    `INSERT INTO item_locks (item_id, user_email, expires_at) VALUES ($1,$2, now() + interval '10 minutes')
     ON CONFLICT (item_id) DO UPDATE SET user_email = EXCLUDED.user_email, expires_at = EXCLUDED.expires_at`,
    [itemId, user.email],
  );
  return { lockedBy: user.email, mine: true };
}

export async function releaseLock(user: SessionUser, itemId: number): Promise<void> {
  await query('DELETE FROM item_locks WHERE item_id = $1 AND user_email = $2', [itemId, user.email]);
}
