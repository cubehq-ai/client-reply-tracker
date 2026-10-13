import pg from 'pg';
import { query, tx } from '../db/pool.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { FIXTURE_CLIENTS } from '../gmail/fixtures.js';
import { InternalDbClientSource } from './internalDb.js';

export interface ClientRecord {
  externalId: string;
  name: string;
  tier: string | null;
  accountManagerEmail: string | null;
  domains: string[];
  contacts: string[];
  slaHours?: number | null;
}

export interface ClientSource {
  listClients(): Promise<ClientRecord[]>;
}

/** Reads clients + domains from the dashboard database (SPEC 10). */
export class DashboardDbClientSource implements ClientSource {
  async listClients(): Promise<ClientRecord[]> {
    const pool = new pg.Pool({ connectionString: config.clientDbUrl, max: 2 });
    try {
      const res = await pool.query(`
        SELECT c.external_id, c.name, c.tier, c.account_manager_email,
               COALESCE(array_agg(DISTINCT d.domain) FILTER (WHERE d.domain IS NOT NULL), '{}') AS domains,
               COALESCE(array_agg(DISTINCT ct.email) FILTER (WHERE ct.email IS NOT NULL), '{}') AS contacts
          FROM clients c
          LEFT JOIN client_domains d ON d.client_id = c.id
          LEFT JOIN client_contacts ct ON ct.client_id = c.id
         GROUP BY c.external_id, c.name, c.tier, c.account_manager_email
      `);
      return res.rows.map((r) => ({
        externalId: String(r.external_id),
        name: r.name,
        tier: r.tier ?? null,
        accountManagerEmail: r.account_manager_email?.toLowerCase() ?? null,
        domains: (r.domains ?? []).map((d: string) => d.toLowerCase()),
        contacts: (r.contacts ?? []).map((e: string) => e.toLowerCase()),
      }));
    } finally {
      await pool.end();
    }
  }
}

export class FixtureClientSource implements ClientSource {
  async listClients(): Promise<ClientRecord[]> {
    return FIXTURE_CLIENTS.map((c) => ({
      externalId: c.externalId,
      name: c.name,
      tier: c.tier,
      accountManagerEmail: c.accountManager,
      domains: c.domains,
      contacts: c.contacts,
    }));
  }
}

export function getClientSource(): ClientSource {
  // The internal tool wins when configured; CLIENT_DB_URL remains as the
  // generic dashboard-DB path from the spec; fixtures otherwise.
  if (config.internalDb.url) return new InternalDbClientSource();
  if (config.clientDbUrl) return new DashboardDbClientSource();
  return new FixtureClientSource();
}

export interface ClientSyncResult {
  clients: number;
  newDomains: string[];
  rematchedItems: number;
  rejectedFreeDomains: string[];
}

/**
 * Upserts clients, domains and contacts, then re-runs matching on open
 * Unmatched items for any domain that is new (SPEC 10).
 */
export async function syncClients(source = getClientSource()): Promise<ClientSyncResult> {
  const records = await source.listClients();
  const freeDomains = new Set(
    (await query<{ domain: string }>('SELECT domain FROM free_email_domains')).map((r) => r.domain.toLowerCase()),
  );
  const newDomains: string[] = [];
  const rejectedFreeDomains: string[] = [];

  for (const rec of records) {
    await tx(async (c) => {
      const amRes = rec.accountManagerEmail
        ? await c.query<{ id: string }>('SELECT id FROM users WHERE email = $1', [rec.accountManagerEmail])
        : null;

      const clientRes = await c.query<{ id: string }>(
        `INSERT INTO clients (external_id, name, tier, account_manager_user_id, sla_hours)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (external_id) DO UPDATE SET
           name = EXCLUDED.name,
           tier = EXCLUDED.tier,
           account_manager_user_id = COALESCE(EXCLUDED.account_manager_user_id, clients.account_manager_user_id),
           sla_hours = COALESCE(EXCLUDED.sla_hours, clients.sla_hours),
           updated_at = now()
         RETURNING id`,
        [rec.externalId, rec.name, rec.tier, amRes?.rows[0] ? Number(amRes.rows[0].id) : null, rec.slaHours ?? null],
      );
      const clientId = Number(clientRes.rows[0]!.id);

      for (const domain of rec.domains) {
        const d = domain.toLowerCase();
        // A free provider domain would match every personal address on it.
        if (freeDomains.has(d)) {
          rejectedFreeDomains.push(d);
          logger.warn({ domain: d, client: rec.name }, 'refusing to map a free email domain to a client; use a contact instead');
          continue;
        }
        const res = await c.query(
          `INSERT INTO client_domains (client_id, domain, source) VALUES ($1,$2,'sync')
           ON CONFLICT (domain) DO UPDATE SET client_id = EXCLUDED.client_id
           RETURNING (xmax = 0) AS inserted`,
          [clientId, d],
        );
        if (res.rows[0]?.inserted) newDomains.push(d);
      }

      for (const email of rec.contacts) {
        await c.query(
          `INSERT INTO client_contacts (client_id, email, source) VALUES ($1,$2,'sync')
           ON CONFLICT (email) DO UPDATE SET client_id = EXCLUDED.client_id`,
          [clientId, email.toLowerCase()],
        );
      }
    });
  }

  const rematchedItems = await rematchUnmatchedItems();
  logger.info({ clients: records.length, newDomains: newDomains.length, rematchedItems }, 'client sync complete');
  return { clients: records.length, newDomains, rematchedItems, rejectedFreeDomains };
}

/**
 * Re-runs client matching over items that have no client yet. Called after a
 * sync and after a manual "Link to client", so the mapping applies
 * retroactively (SPEC 4 step 4).
 */
export async function rematchUnmatchedItems(): Promise<number> {
  const res = await query<{ id: string }>(
    `WITH candidate AS (
       SELECT i.id,
              (SELECT cd.client_id
                 FROM messages m
                 JOIN client_domains cd ON cd.domain = m.from_domain
                WHERE m.conversation_id = i.conversation_id AND m.direction = 'in'
                ORDER BY m.internal_date DESC LIMIT 1) AS by_domain,
              (SELECT cc.client_id
                 FROM messages m
                 JOIN client_contacts cc ON cc.email = m.from_email
                WHERE m.conversation_id = i.conversation_id AND m.direction = 'in'
                ORDER BY m.internal_date DESC LIMIT 1) AS by_email
         FROM items i
        WHERE i.client_id IS NULL
          AND i.state IN ('needs_reply','fyi','snoozed','handled_elsewhere','ignored')
     )
     UPDATE items SET client_id = COALESCE(candidate.by_email, candidate.by_domain), updated_at = now()
       FROM candidate
      WHERE items.id = candidate.id
        AND COALESCE(candidate.by_email, candidate.by_domain) IS NOT NULL
      RETURNING items.id`,
  );
  if (res.length > 0) {
    await query(
      `UPDATE conversations c SET client_id = i.client_id
         FROM items i WHERE i.conversation_id = c.id AND c.client_id IS NULL AND i.client_id IS NOT NULL`,
    );
  }
  return res.length;
}
