import { query, tx } from '../db/pool.js';
import { getDirectoryClient } from '../gmail/index.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { clearMailboxCache } from '../pipeline/ingest.js';

export interface DiscoveryResult {
  users: number;
  mailboxesWatched: number;
  suspended: number;
  reassignedItems: number;
  /** Set when the job did nothing because it cannot reach the Directory. */
  skipped?: string;
}

/**
 * Daily mailbox discovery (SPEC 3.1). Honours the WATCHED_MAILBOXES allowlist
 * and the exclusion list, and hands a suspended user's open items to their
 * manager so nothing silently stops being anyone's problem.
 */
export async function discoverMailboxes(): Promise<DiscoveryResult> {
  // The Directory API needs an admin to impersonate. Without one this job
  // threw every night at 02:00 and the failure sat unread in job_runs;
  // mailboxes are managed in Settings regardless, so skipping is the honest
  // outcome rather than an error nobody acts on.
  if (config.google.backend === 'real' && !config.google.adminSubject) {
    logger.warn('GOOGLE_ADMIN_SUBJECT is not set — skipping mailbox discovery; add mailboxes in Settings');
    return { users: 0, mailboxesWatched: 0, suspended: 0, reassignedItems: 0, skipped: 'no_admin_subject' };
  }

  const directory = getDirectoryClient();
  const users = await directory.listUsers();

  const allowlist = new Set(config.org.watchedMailboxes);
  const excluded = new Set([
    ...config.org.excludedMailboxes,
    ...(await query<{ value: string }>("SELECT value FROM exclusions WHERE kind = 'mailbox'")).map((r) => r.value.toLowerCase()),
  ]);
  const groupAddresses = new Set(config.org.groupAddresses);

  let watched = 0;
  let suspended = 0;
  let reassignedItems = 0;

  for (const u of users) {
    const email = u.email.toLowerCase();
    const isSuspended = u.suspended || Boolean(u.archived);
    const status = excluded.has(email)
      ? 'excluded'
      : isSuspended
        ? 'suspended'
        : allowlist.size > 0 && !allowlist.has(email)
          ? 'paused'
          : 'active';

    await tx(async (c) => {
      const userRes = await c.query<{ id: string }>(
        `INSERT INTO users (email, name, manager_email, status, role)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (email) DO UPDATE SET
           name = EXCLUDED.name,
           manager_email = EXCLUDED.manager_email,
           status = EXCLUDED.status,
           role = CASE WHEN users.role = 'member' THEN EXCLUDED.role ELSE users.role END,
           updated_at = now()
         RETURNING id`,
        [email, u.name, u.managerEmail ?? null, isSuspended ? 'suspended' : 'active', u.isAdmin ? 'admin' : 'member'],
      );
      const userId = Number(userRes.rows[0]!.id);

      await c.query(
        `INSERT INTO mailboxes (email, user_id, kind, status)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (email) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           kind = EXCLUDED.kind,
           status = EXCLUDED.status,
           updated_at = now()`,
        [email, userId, groupAddresses.has(email) ? 'shared' : 'user', status],
      );

      // Suspended user: their open items move to their manager (SPEC 3.1).
      if (isSuspended) {
        const managerId = u.managerEmail
          ? (await c.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [u.managerEmail.toLowerCase()])).rows[0]
          : undefined;
        const res = await c.query(
          `UPDATE items SET owner_user_id = $2, updated_at = now()
            WHERE owner_user_id = $1
              AND state IN ('needs_reply','snoozed','handled_elsewhere','sending')`,
          [userId, managerId ? Number(managerId.id) : null],
        );
        reassignedItems += res.rowCount ?? 0;
      }
    });

    if (status === 'active') watched += 1;
    if (isSuspended) suspended += 1;
  }

  clearMailboxCache();
  logger.info({ users: users.length, watched, suspended, reassignedItems }, 'mailbox discovery complete');
  return { users: users.length, mailboxesWatched: watched, suspended, reassignedItems };
}
