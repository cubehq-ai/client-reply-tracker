import { query } from '../db/pool.js';
import { config } from '../lib/config.js';
import type { SessionUser } from './auth.js';

export type QueueName =
  | 'needs_reply' | 'overdue' | 'unmatched' | 'low_confidence' | 'fyi'
  | 'snoozed' | 'replied' | 'awaiting_client' | 'ignored' | 'filtered' | 'all';

export interface QueueFilters {
  clientId?: number;
  ownerUserId?: number;
  mailbox?: string;
  age?: '4h' | '24h' | '3d' | 'older';
  priority?: 'high' | 'normal' | 'low';
  intent?: string;
  view?: 'mine' | 'team' | 'all';
  search?: string;
  limit?: number;
  offset?: number;
}

export interface QueueItem {
  id: number;
  conversationId: number;
  state: string;
  subject: string;
  clientId: number | null;
  clientName: string | null;
  ownerEmail: string | null;
  priority: string;
  intent: string | null;
  summary: string | null;
  confidence: number | null;
  lowConfidence: boolean;
  lastExternalAt: string | null;
  slaDueAt: string | null;
  overdue: boolean;
  snoozedUntil: string | null;
  repliedAt: string | null;
  repliedBy: string | null;
  reopenCount: number;
  muted: boolean;
  filterReason: string | null;
  awaitingClient: boolean;
  fromEmail: string | null;
  fromName: string | null;
  snippet: string | null;
  mailboxes: string[];
  lockedBy: string | null;
}

/**
 * Row-level visibility (SPEC 11). A member sees items they own or watch, plus
 * items for clients they manage. A manager additionally sees their reports'
 * items. An admin sees everything.
 */
function visibilityClause(user: SessionUser, view: QueueFilters['view'], params: unknown[]): string {
  if (user.role === 'admin' && view !== 'mine' && view !== 'team') return 'TRUE';

  if (view === 'mine' || user.role === 'member') {
    params.push(user.id, user.email);
    const uIdx = params.length - 1;
    const eIdx = params.length;
    return `(i.owner_user_id = $${uIdx} OR $${eIdx} = ANY(i.watchers) OR cl.account_manager_user_id = $${uIdx})`;
  }

  // Manager (or an admin who asked for the team view): self plus direct reports.
  params.push(user.id, user.email);
  const uIdx = params.length - 1;
  const eIdx = params.length;
  return `(
    i.owner_user_id = $${uIdx}
    OR $${eIdx} = ANY(i.watchers)
    OR cl.account_manager_user_id = $${uIdx}
    OR i.owner_user_id IN (SELECT r.id FROM users r WHERE r.manager_email = $${eIdx})
  )`;
}

function queueClause(queue: QueueName, params: unknown[]): string {
  switch (queue) {
    case 'needs_reply':
      return "i.state = 'needs_reply' AND i.client_id IS NOT NULL";
    case 'overdue':
      return "i.state = 'needs_reply' AND i.sla_due_at IS NOT NULL AND i.sla_due_at < now()";
    case 'unmatched':
      return "i.state = 'needs_reply' AND i.client_id IS NULL";
    case 'low_confidence':
      params.push(config.classifier.threshold);
      return `i.state IN ('needs_reply','fyi') AND i.needs_reply_confidence IS NOT NULL AND i.needs_reply_confidence < $${params.length}`;
    case 'fyi':
      return "i.state = 'fyi'";
    case 'snoozed':
      return "i.state = 'snoozed'";
    case 'replied':
      return "i.state = 'replied' AND i.replied_at > now() - interval '7 days'";
    case 'awaiting_client':
      return "i.state = 'replied' AND i.awaiting_client = true";
    case 'ignored':
      return "i.state = 'ignored' AND i.state_since > now() - interval '30 days'";
    case 'filtered':
      return "i.state = 'auto_ignored'";
    case 'all':
      return "i.state <> 'archived'";
    default:
      return 'TRUE';
  }
}

function orderClause(queue: QueueName): string {
  switch (queue) {
    case 'needs_reply':
      // Priority first, then oldest (SPEC 7).
      return "CASE i.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END ASC, i.last_external_at ASC NULLS LAST";
    case 'overdue':
    case 'awaiting_client':
      return 'i.last_external_at ASC NULLS LAST';
    case 'snoozed':
      return 'i.snoozed_until ASC NULLS LAST';
    case 'replied':
      return 'i.replied_at DESC NULLS LAST';
    default:
      return 'i.last_external_at DESC NULLS LAST';
  }
}

function ageClause(age: QueueFilters['age']): string {
  switch (age) {
    case '4h': return "i.last_external_at > now() - interval '4 hours'";
    case '24h': return "i.last_external_at BETWEEN now() - interval '24 hours' AND now() - interval '4 hours'";
    case '3d': return "i.last_external_at BETWEEN now() - interval '3 days' AND now() - interval '24 hours'";
    case 'older': return "i.last_external_at < now() - interval '3 days'";
    default: return 'TRUE';
  }
}

export async function listQueue(
  user: SessionUser,
  queue: QueueName,
  filters: QueueFilters = {},
): Promise<{ items: QueueItem[]; total: number }> {
  const params: unknown[] = [];
  const where = [queueClause(queue, params), visibilityClause(user, filters.view, params)];

  if (filters.clientId !== undefined) { params.push(filters.clientId); where.push(`i.client_id = $${params.length}`); }
  if (filters.ownerUserId !== undefined) { params.push(filters.ownerUserId); where.push(`i.owner_user_id = $${params.length}`); }
  if (filters.priority) { params.push(filters.priority); where.push(`i.priority = $${params.length}`); }
  if (filters.intent) { params.push(filters.intent); where.push(`i.intent = $${params.length}`); }
  if (filters.age) where.push(ageClause(filters.age));
  if (filters.mailbox) {
    params.push(filters.mailbox.toLowerCase());
    where.push(`EXISTS (SELECT 1 FROM message_copies mc JOIN messages m ON m.id = mc.message_id
                        JOIN mailboxes mb ON mb.id = mc.mailbox_id
                        WHERE m.conversation_id = i.conversation_id AND mb.email = $${params.length})`);
  }
  if (filters.search) {
    params.push(`%${filters.search}%`);
    where.push(`(c.subject ILIKE $${params.length} OR i.summary ILIKE $${params.length})`);
  }

  const limit = Math.min(200, filters.limit ?? 50);
  const offset = filters.offset ?? 0;

  const sql = `
    WITH base AS (
      SELECT i.*, c.subject, c.id AS conv_id, cl.name AS client_name,
             u.email AS owner_email,
             (SELECT m.from_email FROM messages m
               WHERE m.conversation_id = i.conversation_id AND m.direction = 'in'
               ORDER BY m.internal_date DESC LIMIT 1) AS from_email,
             (SELECT m.snippet FROM messages m
               WHERE m.conversation_id = i.conversation_id AND m.direction = 'in'
               ORDER BY m.internal_date DESC LIMIT 1) AS snippet,
             (SELECT COALESCE(array_agg(DISTINCT mb.email), '{}') FROM message_copies mc
                JOIN messages m ON m.id = mc.message_id
                JOIN mailboxes mb ON mb.id = mc.mailbox_id
               WHERE m.conversation_id = i.conversation_id AND mc.deleted = false) AS mailboxes,
             (SELECT l.user_email FROM item_locks l WHERE l.item_id = i.id AND l.expires_at > now()) AS locked_by,
             count(*) OVER () AS total_count
        FROM items i
        JOIN conversations c ON c.id = i.conversation_id
        LEFT JOIN clients cl ON cl.id = i.client_id
        LEFT JOIN users u ON u.id = i.owner_user_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderClause(queue)}
       LIMIT ${limit} OFFSET ${offset}
    )
    SELECT * FROM base`;

  const rows = await query<any>(sql, params);
  const total = rows[0] ? Number(rows[0].total_count) : 0;

  return {
    total,
    items: rows.map((r) => ({
      id: Number(r.id),
      conversationId: Number(r.conv_id),
      state: r.state,
      subject: r.subject ?? '(no subject)',
      clientId: r.client_id ? Number(r.client_id) : null,
      clientName: r.client_name,
      ownerEmail: r.owner_email,
      priority: r.priority,
      intent: r.intent,
      summary: r.summary,
      confidence: r.needs_reply_confidence === null ? null : Number(r.needs_reply_confidence),
      lowConfidence: r.needs_reply_confidence !== null && Number(r.needs_reply_confidence) < config.classifier.threshold,
      lastExternalAt: r.last_external_at?.toISOString?.() ?? null,
      slaDueAt: r.sla_due_at?.toISOString?.() ?? null,
      overdue: Boolean(r.sla_due_at && r.state === 'needs_reply' && r.sla_due_at < new Date()),
      snoozedUntil: r.snoozed_until?.toISOString?.() ?? null,
      repliedAt: r.replied_at?.toISOString?.() ?? null,
      repliedBy: r.replied_by,
      reopenCount: Number(r.reopen_count ?? 0),
      muted: Boolean(r.muted),
      filterReason: r.filter_reason,
      awaitingClient: Boolean(r.awaiting_client),
      fromEmail: r.from_email,
      fromName: null,
      snippet: r.snippet,
      mailboxes: r.mailboxes ?? [],
      lockedBy: r.locked_by ?? null,
    })),
  };
}

/** Counts for the sidebar badges, scoped the same way as the queues. */
export async function queueCounts(user: SessionUser, view: QueueFilters['view'] = 'all'): Promise<Record<string, number>> {
  const names: QueueName[] = ['needs_reply', 'overdue', 'unmatched', 'low_confidence', 'fyi', 'snoozed', 'replied', 'awaiting_client', 'ignored', 'filtered'];
  const out: Record<string, number> = {};
  await Promise.all(
    names.map(async (name) => {
      const params: unknown[] = [];
      const where = [queueClause(name, params), visibilityClause(user, view, params)];
      const rows = await query<{ n: string }>(
        `SELECT count(*)::int AS n FROM items i
           JOIN conversations c ON c.id = i.conversation_id
           LEFT JOIN clients cl ON cl.id = i.client_id
          WHERE ${where.join(' AND ')}`,
        params,
      );
      out[name] = Number(rows[0]?.n ?? 0);
    }),
  );
  return out;
}

/** Client roll-up for the "By client" view (SPEC 7). */
export async function clientOverview(user: SessionUser, view: QueueFilters['view'] = 'all'): Promise<any[]> {
  const params: unknown[] = [];
  const vis = visibilityClause(user, view, params);
  return query(
    `SELECT cl.id, cl.name, cl.tier,
            count(*) FILTER (WHERE i.state = 'needs_reply')::int AS open_count,
            count(*) FILTER (WHERE i.state = 'needs_reply' AND i.sla_due_at < now())::int AS overdue_count,
            MIN(i.last_external_at) FILTER (WHERE i.state = 'needs_reply') AS oldest_open,
            u.email AS account_manager
       FROM clients cl
       LEFT JOIN items i ON i.client_id = cl.id AND ${vis}
       LEFT JOIN users u ON u.id = cl.account_manager_user_id
      WHERE cl.archived = false
      GROUP BY cl.id, cl.name, cl.tier, u.email
      ORDER BY open_count DESC, cl.name ASC`,
    params,
  );
}
