import { query } from '../db/pool.js';

export interface Metrics {
  openByOwner: any[];
  openByClient: any[];
  responseTimes: any[];
  slaBreaches: number;
  reopenRate: number;
  classifier: { fyiUpgraded: number; totalFyi: number; needsReplyIgnored: number; totalNeedsReply: number; precision: number | null };
  filterAudit: { autoIgnored: number; restored: number; restoreRate: number | null };
}

/** SPEC 14. Percentiles use percentile_cont over seconds-to-first-reply. */
export async function computeMetrics(): Promise<Metrics> {
  const [openByOwner, openByClient, responseTimes, breaches, reopen, fyi, filtered] = await Promise.all([
    query(`SELECT COALESCE(u.email,'(unowned)') AS owner,
                  count(*) FILTER (WHERE i.state = 'needs_reply')::int AS open_count,
                  MIN(i.last_external_at) FILTER (WHERE i.state = 'needs_reply') AS oldest_open
             FROM items i LEFT JOIN users u ON u.id = i.owner_user_id
            WHERE i.state <> 'archived'
            GROUP BY u.email ORDER BY open_count DESC`),

    query(`SELECT COALESCE(cl.name,'(unmatched)') AS client,
                  count(*) FILTER (WHERE i.state = 'needs_reply')::int AS open_count,
                  count(*) FILTER (WHERE i.state = 'needs_reply' AND i.sla_due_at < now())::int AS overdue_count,
                  MIN(i.last_external_at) FILTER (WHERE i.state = 'needs_reply') AS oldest_open
             FROM items i LEFT JOIN clients cl ON cl.id = i.client_id
            WHERE i.state <> 'archived'
            GROUP BY cl.name ORDER BY open_count DESC`),

    query(`SELECT COALESCE(cl.name,'(unmatched)') AS client,
                  COALESCE(i.replied_by,'(unknown)') AS owner,
                  count(*)::int AS replies,
                  ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY i.response_time_seconds)/60.0)::int AS median_minutes,
                  ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY i.response_time_seconds)/60.0)::int AS p90_minutes
             FROM items i LEFT JOIN clients cl ON cl.id = i.client_id
            WHERE i.response_time_seconds IS NOT NULL
            GROUP BY cl.name, i.replied_by ORDER BY replies DESC`),

    query<{ n: string }>(`SELECT count(*)::int AS n FROM items WHERE state = 'needs_reply' AND sla_due_at < now()`),

    query<{ reopened: string; total: string }>(
      `SELECT count(*) FILTER (WHERE reopen_count > 0)::int AS reopened, count(*)::int AS total
         FROM items WHERE state <> 'archived'`,
    ),

    query<{ fyi_upgraded: string; total_fyi: string; nr_ignored: string; total_nr: string }>(
      `SELECT
         (SELECT count(*)::int FROM classifier_feedback WHERE predicted = 'fyi' AND actual = 'needs_reply') AS fyi_upgraded,
         (SELECT count(*)::int FROM items WHERE state = 'fyi' OR id IN (SELECT item_id FROM classifier_feedback WHERE predicted = 'fyi')) AS total_fyi,
         (SELECT count(*)::int FROM items WHERE state = 'ignored' AND intent IS NOT NULL) AS nr_ignored,
         (SELECT count(*)::int FROM items WHERE intent IS NOT NULL) AS total_nr`,
    ),

    query<{ auto_ignored: string; restored: string }>(
      `SELECT count(*) FILTER (WHERE state = 'auto_ignored')::int AS auto_ignored,
              count(*) FILTER (WHERE restored_from_filter)::int AS restored
         FROM items`,
    ),
  ]);

  const r = reopen[0];
  const f = fyi[0];
  const fl = filtered[0];
  const totalFyi = Number(f?.total_fyi ?? 0);
  const autoIgnored = Number(fl?.auto_ignored ?? 0);
  const restored = Number(fl?.restored ?? 0);

  return {
    openByOwner,
    openByClient,
    responseTimes,
    slaBreaches: Number(breaches[0]?.n ?? 0),
    reopenRate: Number(r?.total ?? 0) > 0 ? Number(r!.reopened) / Number(r!.total) : 0,
    classifier: {
      fyiUpgraded: Number(f?.fyi_upgraded ?? 0),
      totalFyi,
      needsReplyIgnored: Number(f?.nr_ignored ?? 0),
      totalNeedsReply: Number(f?.total_nr ?? 0),
      // Share of FYI calls the users did NOT overturn.
      precision: totalFyi > 0 ? 1 - Number(f!.fyi_upgraded) / totalFyi : null,
    },
    filterAudit: {
      autoIgnored,
      restored,
      restoreRate: autoIgnored + restored > 0 ? restored / (autoIgnored + restored) : null,
    },
  };
}
