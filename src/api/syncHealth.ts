import { one } from '../db/pool.js';

export interface SyncHealth {
  /** Oldest last_synced_at across active mailboxes; null if none ever synced. */
  oldestSyncedAt: string | null;
  newestSyncedAt: string | null;
  /** Mailboxes whose last sync is older than the staleness threshold. */
  staleMailboxes: number;
  activeMailboxes: number;
  /** When the worker last finished any job; null if it has never run here. */
  workerLastRunAt: string | null;
  /** True when ingestion has plainly stopped and the view is a frozen snapshot. */
  stale: boolean;
  thresholdMinutes: number;
}

/**
 * Whether ingestion is actually running.
 *
 * A stopped worker looks exactly like a quiet inbox: the dashboard keeps
 * serving its last snapshot and nothing appears wrong. This is what lets the
 * UI say so out loud.
 */
export async function syncHealth(thresholdMinutes = 30): Promise<SyncHealth> {
  const row = await one<{
    oldest: Date | null; newest: Date | null; stale: string; active: string; worker: Date | null;
  }>(
    `SELECT MIN(mb.last_synced_at) AS oldest,
            MAX(mb.last_synced_at) AS newest,
            count(*) FILTER (
              WHERE mb.last_synced_at IS NULL
                 OR mb.last_synced_at < now() - ($1 || ' minutes')::interval
            )::int AS stale,
            count(*)::int AS active,
            (SELECT MAX(finished_at) FROM job_runs WHERE ok = true) AS worker
       FROM mailboxes mb
      WHERE mb.status = 'active'`,
    [String(thresholdMinutes)],
  );

  const stale = Number(row?.stale ?? 0);
  const active = Number(row?.active ?? 0);

  return {
    oldestSyncedAt: row?.oldest?.toISOString() ?? null,
    newestSyncedAt: row?.newest?.toISOString() ?? null,
    staleMailboxes: stale,
    activeMailboxes: active,
    workerLastRunAt: row?.worker?.toISOString() ?? null,
    // Every mailbox behind means ingestion has stopped, not that one lagged.
    stale: active > 0 && stale === active,
    thresholdMinutes,
  };
}
