import type { PoolClient } from 'pg';
import { logger } from '../lib/logger.js';
import { fallbackConversationKey, threadIdentifiers, type NormalizedMessage } from './normalize.js';

export interface ResolvedConversation {
  id: number;
  created: boolean;
}

/**
 * Finds or creates the global conversation for a message (SPEC 2).
 *
 * Gmail thread ids are per mailbox, so they are useless as a global key. The
 * RFC chain is the only thing shared across mailboxes: if any id this message
 * carries is already known, it belongs to that conversation. When a message
 * links two conversations we had seen separately, they are merged.
 */
export async function resolveConversation(
  c: PoolClient,
  msg: NormalizedMessage,
  orgDomains: Set<string>,
): Promise<ResolvedConversation> {
  const ids = threadIdentifiers(msg);

  const existing = await c.query<{ conversation_id: string }>(
    'SELECT DISTINCT conversation_id FROM conversation_keys WHERE rfc_message_id = ANY($1::text[])',
    [ids],
  );
  let conversationId: number | null = null;

  if (existing.rows.length > 0) {
    const found = existing.rows.map((r) => Number(r.conversation_id)).sort((a, b) => a - b);
    conversationId = found[0]!;
    if (found.length > 1) {
      await mergeConversations(c, conversationId, found.slice(1));
    }
  }

  if (conversationId === null) {
    // No RFC overlap. Fall back to subject + external participants, which
    // catches clients whose mail client drops the References chain.
    const fallbackKey = fallbackConversationKey(msg, orgDomains);
    const viaFallback = await c.query<{ id: string }>(
      `SELECT id FROM conversations
        WHERE global_key = $1
          AND COALESCE(last_external_at, created_at) > now() - interval '30 days'
        LIMIT 1`,
      [fallbackKey],
    );
    if (viaFallback.rows[0]) {
      conversationId = Number(viaFallback.rows[0].id);
    } else {
      // Root of the chain is the stable identity for a new conversation.
      const globalKey = msg.references[0] ?? msg.inReplyTo ?? msg.rfcMessageId;
      const inserted = await c.query<{ id: string }>(
        `INSERT INTO conversations (global_key, subject)
         VALUES ($1, $2)
         ON CONFLICT (global_key) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [globalKey, msg.subject],
      );
      conversationId = Number(inserted.rows[0]!.id);
      await registerKeys(c, conversationId, ids);
      return { id: conversationId, created: true };
    }
  }

  await registerKeys(c, conversationId, ids);
  return { id: conversationId, created: false };
}

async function registerKeys(c: PoolClient, conversationId: number, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await c.query(
    `INSERT INTO conversation_keys (rfc_message_id, conversation_id)
     SELECT unnest($1::text[]), $2
     ON CONFLICT (rfc_message_id) DO NOTHING`,
    [ids, conversationId],
  );
}

/**
 * Folds `dropIds` into `keepId`. Happens when a later message proves two
 * separately-seen threads are one conversation — common when a client replies
 * to an older mail from an address we had not linked yet.
 */
export async function mergeConversations(c: PoolClient, keepId: number, dropIds: number[]): Promise<void> {
  if (dropIds.length === 0) return;
  logger.info({ keepId, dropIds }, 'merging conversations');

  await c.query('UPDATE conversation_keys SET conversation_id = $1 WHERE conversation_id = ANY($2::bigint[])', [keepId, dropIds]);
  await c.query('UPDATE messages SET conversation_id = $1 WHERE conversation_id = ANY($2::bigint[])', [keepId, dropIds]);

  // Keep the surviving item and move history onto it; the state machine
  // recomputes state from the merged message set immediately after.
  const keepItem = await c.query<{ id: string }>('SELECT id FROM items WHERE conversation_id = $1', [keepId]);
  const keepItemId = keepItem.rows[0] ? Number(keepItem.rows[0].id) : null;
  if (keepItemId) {
    await c.query(
      `UPDATE item_events SET item_id = $1
        WHERE item_id IN (SELECT id FROM items WHERE conversation_id = ANY($2::bigint[]))`,
      [keepItemId, dropIds],
    );
    await c.query(
      `UPDATE items SET reopen_count = reopen_count + COALESCE((
          SELECT SUM(reopen_count) FROM items WHERE conversation_id = ANY($2::bigint[])
        ), 0)
        WHERE id = $1`,
      [keepItemId, dropIds],
    );
  }

  // Aggregate the dropped rows separately: a LATERAL unnest over
  // participants_ext would drop any conversation with an empty array and lose
  // its timestamps with it.
  await c.query(
    `WITH agg AS (
       SELECT MIN(first_external_at) AS first_ext,
              MAX(last_external_at)  AS last_ext,
              MAX(last_internal_at)  AS last_int,
              MIN(client_id)         AS client_id,
              COALESCE(
                (SELECT array_agg(DISTINCT p)
                   FROM conversations d2, LATERAL unnest(d2.participants_ext) AS p
                  WHERE d2.id = ANY($2::bigint[])),
                '{}'::text[]
              ) AS participants
         FROM conversations
        WHERE id = ANY($2::bigint[])
     )
     UPDATE conversations keep SET
       participants_ext  = ARRAY(SELECT DISTINCT unnest(keep.participants_ext || agg.participants)),
       first_external_at = LEAST(keep.first_external_at, agg.first_ext),
       last_external_at  = GREATEST(keep.last_external_at, agg.last_ext),
       last_internal_at  = GREATEST(keep.last_internal_at, agg.last_int),
       client_id         = COALESCE(keep.client_id, agg.client_id),
       updated_at        = now()
     FROM agg
     WHERE keep.id = $1`,
    [keepId, dropIds],
  );

  await c.query('DELETE FROM items WHERE conversation_id = ANY($1::bigint[])', [dropIds]);
  await c.query('DELETE FROM conversations WHERE id = ANY($1::bigint[])', [dropIds]);
}
