import { query } from '../db/pool.js';
import { config } from '../lib/config.js';
import type { SessionUser } from './auth.js';

/** Two tabs (CLAUDE.md override 1). Everything else is a filter. */
export type QueueName = 'needs_reply' | 'no_reply_needed' | 'all';

export type AgeBucket = '4h' | '24h' | '3d' | 'older';

export interface QueueFilters {
  /** Every list filter is multi-select; an empty list means "no restriction". */
  clientIds?: number[];
  ownerUserIds?: number[];
  teamIds?: number[];
  mailbox?: string;
  ages?: AgeBucket[];
  priorities?: ('high' | 'normal' | 'low')[];
  intent?: string;
  view?: 'mine' | 'team' | 'all';
  search?: string;
  /** Channel tab. Only gmail exists in v1; Slack is planned (SPEC 15).  */
  source?: 'gmail' | 'slack';
  /** One or more item states. Empty means "every active state". */
  status?: string[];
  /**
   * Split of `needs_reply` by how long it has gone unanswered:
   * 'aged' is past UNRESPONDED_AFTER_HOURS, 'fresh' is still within it.
   */
  freshness?: 'aged' | 'fresh';
  /** Why a closed item is closed: replied | not_needed | filtered | ignored. */
  reasons?: string[];
  /** Flags on an item, not states. */
  unmatched?: boolean;
  lowConfidence?: boolean;
  muted?: boolean;
  limit?: number;
  offset?: number;
}

/** States an item can be in while it is still live work. */
export const ACTIVE_STATES = ['needs_reply', 'sending', 'snoozed', 'handled_elsewhere'];

export interface QueueItem {
  id: number;
  conversationId: number;
  state: string;
  subject: string;
  clientId: number | null;
  clientName: string | null;
  ownerEmail: string | null;
  summary: string | null;
  reason: string | null;
  confidence: number | null;
  lowConfidence: boolean;
  lastExternalAt: string | null;
  slaDueAt: string | null;
  repliedAt: string | null;
  repliedBy: string | null;
  reopenCount: number;
  muted: boolean;
  filterReason: string | null;
  fromEmail: string | null;
  fromName: string | null;
  snippet: string | null;
  mailboxes: string[];
  teamName: string | null;
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
      return "i.state = 'needs_reply'";
    case 'no_reply_needed':
      // Closed items age off the tab: a list that only ever grows stops being
      // something anyone reviews.
      params.push(String(config.org.closedVisibleDays));
      return `i.state = 'no_reply_needed' AND i.state_since > now() - ($${params.length} || ' days')::interval`;
    default:
      return 'TRUE';
  }
}

function orderClause(queue: QueueName): string {
  // Longest unanswered first. There is no second key: the product tracks what
  // has gone unattended, not who is late.
  if (queue === 'needs_reply') return 'i.last_external_at ASC NULLS LAST';
  return 'i.state_since DESC NULLS LAST, i.last_external_at DESC NULLS LAST';
}

function ageClause(age: AgeBucket): string {
  switch (age) {
    case '4h': return "i.last_external_at > now() - interval '4 hours'";
    case '24h': return "i.last_external_at BETWEEN now() - interval '24 hours' AND now() - interval '4 hours'";
    case '3d': return "i.last_external_at BETWEEN now() - interval '3 days' AND now() - interval '24 hours'";
    case 'older': return "i.last_external_at < now() - interval '3 days'";
    default: return 'TRUE';
  }
}

/** Selected age buckets are alternatives, so they OR together. */
function agesClause(ages: AgeBucket[] | undefined): string | null {
  if (!ages?.length) return null;
  return `(${ages.map(ageClause).join(' OR ')})`;
}

export async function listQueue(
  user: SessionUser,
  queue: QueueName,
  filters: QueueFilters = {},
): Promise<{ items: QueueItem[]; total: number }> {
  const params: unknown[] = [];
  const where = [queueClause(queue, params), visibilityClause(user, filters.view, params)];

  if (filters.clientIds?.length) { params.push(filters.clientIds); where.push(`i.client_id = ANY($${params.length}::bigint[])`); }
  if (filters.ownerUserIds?.length) { params.push(filters.ownerUserIds); where.push(`i.owner_user_id = ANY($${params.length}::bigint[])`); }
  if (filters.reasons?.length) { params.push(filters.reasons); where.push(`i.reason = ANY($${params.length}::text[])`); }
  const ages = agesClause(filters.ages);
  if (ages) where.push(ages);
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

  if (filters.teamIds?.length) {
    params.push(filters.teamIds);
    where.push(`(u.team_id = ANY($${params.length}::bigint[]) OR mb_team.team_id = ANY($${params.length}::bigint[]))`);
  }
  if (filters.source) { params.push(filters.source); where.push(`i.source = $${params.length}`); }
  if (filters.status?.length) { params.push(filters.status); where.push(`i.state = ANY($${params.length}::text[])`); }
  if (filters.freshness) {
    params.push(String(config.org.unrespondedAfterHours));
    const op = filters.freshness === 'aged' ? '<=' : '>';
    where.push(`i.last_external_at ${op} now() - ($${params.length} || ' hours')::interval`);
  }
  if (filters.unmatched) where.push('i.unmatched_client = true');
  if (filters.muted) where.push('i.muted = true');
  if (filters.lowConfidence) where.push('i.low_confidence = true');

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
             (SELECT COALESCE(array_agg(DISTINCT mb.email), '{}'::text[]) FROM message_copies mc
                JOIN messages m ON m.id = mc.message_id
                JOIN mailboxes mb ON mb.id = mc.mailbox_id
               WHERE m.conversation_id = i.conversation_id AND mc.deleted = false) AS mailboxes,
             (SELECT l.user_email FROM item_locks l WHERE l.item_id = i.id AND l.expires_at > now()) AS locked_by,
             COALESCE(t_owner.name, t_mb.name) AS team_name,
             count(*) OVER () AS total_count
        FROM items i
        JOIN conversations c ON c.id = i.conversation_id
        LEFT JOIN clients cl ON cl.id = i.client_id
        LEFT JOIN users u ON u.id = i.owner_user_id
        LEFT JOIN LATERAL (
          SELECT mb.team_id FROM message_copies mc
            JOIN messages m ON m.id = mc.message_id
            JOIN mailboxes mb ON mb.id = mc.mailbox_id
           WHERE m.conversation_id = i.conversation_id AND mb.team_id IS NOT NULL
           LIMIT 1
        ) mb_team ON true
        LEFT JOIN teams t_owner ON t_owner.id = u.team_id
        LEFT JOIN teams t_mb ON t_mb.id = mb_team.team_id
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
      summary: r.summary,
      reason: r.reason,
      confidence: r.needs_reply_confidence === null ? null : Number(r.needs_reply_confidence),
      lowConfidence: Boolean(r.low_confidence),
      lastExternalAt: r.last_external_at?.toISOString?.() ?? null,
      slaDueAt: r.sla_due_at?.toISOString?.() ?? null,
      repliedAt: r.replied_at?.toISOString?.() ?? null,
      repliedBy: r.replied_by,
      reopenCount: Number(r.reopen_count ?? 0),
      muted: Boolean(r.muted),
      filterReason: r.filter_reason,
      fromEmail: r.from_email,
      fromName: null,
      snippet: r.snippet,
      mailboxes: r.mailboxes ?? [],
      teamName: r.team_name ?? null,
      lockedBy: r.locked_by ?? null,
    })),
  };
}

/** Counts for the two tabs, scoped the same way as the lists. */
export async function queueCounts(user: SessionUser, view: QueueFilters['view'] = 'all'): Promise<Record<string, number>> {
  const params: unknown[] = [];
  const vis = visibilityClause(user, view, params);
  const rows = await query<{ state: string; n: string }>(
    `SELECT i.state, count(*)::int AS n
       FROM items i
       JOIN conversations c ON c.id = i.conversation_id
       LEFT JOIN clients cl ON cl.id = i.client_id
       LEFT JOIN users u ON u.id = i.owner_user_id
      WHERE ${vis}
      GROUP BY i.state`,
    params,
  );
  const out: Record<string, number> = { needs_reply: 0, no_reply_needed: 0 };
  for (const r of rows) out[r.state] = Number(r.n);
  return out;
}

/** Client roll-up for the "By client" view (SPEC 7). */
export async function clientOverview(user: SessionUser, view: QueueFilters['view'] = 'all'): Promise<any[]> {
  const params: unknown[] = [];
  const vis = visibilityClause(user, view, params);
  return query(
    `SELECT cl.id, cl.name, cl.tier,
            count(*) FILTER (WHERE i.state = 'needs_reply')::int AS open_count,
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

/**
 * Counts for the inbox filter chips, computed inside the *current* filter
 * scope. These are deliberately overlapping subsets, which is why they are
 * chips rather than sidebar entries: each is a slice of the current tab,
 * not a sibling of it.
 */
export async function inboxFacets(user: SessionUser, filters: QueueFilters = {}, tab: QueueName = 'needs_reply'): Promise<{
  needsReply: number;
  noReplyNeeded: number;
  reasons: Record<string, number>;
  unmatched: number;
  lowConfidence: number;
  notReplied: number;
  fresh: number;
  thresholdHours: number;
  total: number;
}> {
  const params: unknown[] = [];
  const where = [visibilityClause(user, filters.view, params)];

  if (filters.clientIds?.length) { params.push(filters.clientIds); where.push(`i.client_id = ANY($${params.length}::bigint[])`); }
  if (filters.ownerUserIds?.length) { params.push(filters.ownerUserIds); where.push(`i.owner_user_id = ANY($${params.length}::bigint[])`); }
  if (filters.teamIds?.length) { params.push(filters.teamIds); where.push(`u.team_id = ANY($${params.length}::bigint[])`); }
  if (filters.source) { params.push(filters.source); where.push(`i.source = $${params.length}`); }
  if (filters.search) { params.push(`%${filters.search}%`); where.push(`(c.subject ILIKE $${params.length} OR i.summary ILIKE $${params.length})`); }
  const ageFacet = agesClause(filters.ages);
  if (ageFacet) where.push(ageFacet);

  params.push(String(config.org.unrespondedAfterHours));
  const agedIdx = params.length;
  params.push(String(config.org.closedVisibleDays));
  const closedIdx = params.length;

  // Flag counts are scoped to the tab being viewed, or they would describe
  // items the list cannot show.
  const tabFilter = tab === 'no_reply_needed' ? "i.state = 'no_reply_needed'" : "i.state = 'needs_reply'";

  const rows = await query<any>(
    `SELECT i.state, i.reason,
            count(*)::int AS n,
            count(*) FILTER (WHERE i.unmatched_client AND ${tabFilter})::int AS unmatched,
            count(*) FILTER (WHERE i.low_confidence AND ${tabFilter})::int AS low_conf,
            count(*) FILTER (WHERE i.state = 'needs_reply'
              AND i.last_external_at <= now() - ($${agedIdx} || ' hours')::interval)::int AS aged,
            count(*) FILTER (WHERE i.state = 'needs_reply'
              AND i.last_external_at > now() - ($${agedIdx} || ' hours')::interval)::int AS fresh
       FROM items i
       JOIN conversations c ON c.id = i.conversation_id
       LEFT JOIN clients cl ON cl.id = i.client_id
       LEFT JOIN users u ON u.id = i.owner_user_id
      WHERE ${where.join(' AND ')}
        AND (i.state = 'needs_reply'
             OR i.state_since > now() - ($${closedIdx} || ' days')::interval)
      GROUP BY i.state, i.reason`,
    params,
  );

  const reasons: Record<string, number> = {};
  let needsReply = 0, noReplyNeeded = 0, unmatched = 0, lowConfidence = 0, notReplied = 0, fresh = 0;
  for (const r of rows) {
    const n = Number(r.n);
    if (r.state === 'needs_reply') needsReply += n; else noReplyNeeded += n;
    if (r.reason) reasons[r.reason] = (reasons[r.reason] ?? 0) + n;
    unmatched += Number(r.unmatched);
    lowConfidence += Number(r.low_conf);
    notReplied += Number(r.aged);
    fresh += Number(r.fresh);
  }

  return {
    needsReply, noReplyNeeded, reasons, unmatched, lowConfidence,
    notReplied, fresh, thresholdHours: config.org.unrespondedAfterHours,
    total: needsReply + noReplyNeeded,
  };
}

/** Per-team roll-up for the Teams view. */
export async function teamOverview(user: SessionUser, view: QueueFilters['view'] = 'all'): Promise<any[]> {
  const params: unknown[] = [];
  const vis = visibilityClause(user, view, params);
  return query(
    `SELECT t.id, t.name,
            count(DISTINCT u.id)::int AS members,
            count(i.id) FILTER (WHERE i.state = 'needs_reply')::int AS open_count,
            MIN(i.last_external_at) FILTER (WHERE i.state = 'needs_reply') AS oldest_open
       FROM teams t
       LEFT JOIN users u ON u.team_id = t.id AND u.status = 'active'
       LEFT JOIN items i ON i.owner_user_id = u.id AND ${vis}
       LEFT JOIN clients cl ON cl.id = i.client_id
      GROUP BY t.id, t.name
      ORDER BY open_count DESC, t.name ASC`,
    params,
  );
}
