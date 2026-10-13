import pg from 'pg';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import type { ClientRecord, ClientSource } from './clients.js';

/**
 * Reads clients (and optionally employees) from the internal tool's database.
 *
 * Every statement runs inside a READ ONLY transaction, so this cannot write to
 * that database even if a query were wrong. Only grant the login SELECT.
 */

function pool(): pg.Pool {
  if (!config.internalDb.url) throw new Error('INTERNAL_DB_URL is not set');
  return new pg.Pool({
    connectionString: config.internalDb.url,
    max: 2,
    ssl: /neon\.tech|sslmode=require|amazonaws/.test(config.internalDb.url) ? { rejectUnauthorized: false } : undefined,
  });
}

async function readOnly<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const p = pool();
  const client = await p.connect();
  try {
    await client.query('BEGIN TRANSACTION READ ONLY');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await p.end();
  }
}

export interface TableInfo {
  schema: string;
  table: string;
  columns: { name: string; type: string }[];
  rowEstimate: number;
}

/**
 * Lists tables and columns so the mapping can be written against the real
 * schema instead of guessed. Run `npx tsx src/cli.ts inspect-internal-db`.
 */
export async function inspectInternalDb(): Promise<{ tables: TableInfo[]; likelyClients: string[]; likelyEmployees: string[] }> {
  return readOnly(async (c) => {
    const cols = await c.query<{ table_schema: string; table_name: string; column_name: string; data_type: string }>(
      `SELECT table_schema, table_name, column_name, data_type
         FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog','information_schema')
        ORDER BY table_schema, table_name, ordinal_position`,
    );
    const counts = await c.query<{ relname: string; n: string }>(
      `SELECT relname, GREATEST(n_live_tup, 0) AS n FROM pg_stat_user_tables`,
    );
    const byTable = new Map<string, TableInfo>();
    for (const r of cols.rows) {
      const key = `${r.table_schema}.${r.table_name}`;
      const entry = byTable.get(key) ?? {
        schema: r.table_schema,
        table: r.table_name,
        columns: [],
        rowEstimate: Number(counts.rows.find((x) => x.relname === r.table_name)?.n ?? 0),
      };
      entry.columns.push({ name: r.column_name, type: r.data_type });
      byTable.set(key, entry);
    }
    const tables = [...byTable.values()];
    const name = (t: TableInfo) => t.table.toLowerCase();
    return {
      tables,
      likelyClients: tables.filter((t) => /client|customer|account|brand/.test(name(t))).map((t) => `${t.schema}.${t.table}`),
      likelyEmployees: tables.filter((t) => /employee|user|member|staff|people/.test(name(t))).map((t) => `${t.schema}.${t.table}`),
    };
  });
}

/**
 * Default client query. Deliberately tolerant: it only requires a name, and
 * picks up a domain or website column if one exists. Override with
 * INTERNAL_DB_CLIENTS_QUERY once the real shape is known.
 *
 * Must return: external_id, name, and optionally tier, account_manager_email,
 * domains (text[] or comma string), contacts (text[] or comma string).
 */
const DEFAULT_CLIENTS_QUERY = `
  SELECT id::text AS external_id,
         name,
         NULL::text AS tier,
         NULL::text AS account_manager_email,
         NULL::text AS domains,
         NULL::text AS contacts
    FROM clients
   WHERE COALESCE(name, '') <> ''
`;

function toList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((v) => String(v).toLowerCase().trim()).filter(Boolean);
  return String(value).split(/[,;\s]+/).map((v) => v.toLowerCase().trim()).filter(Boolean);
}

/** Pulls a bare domain out of a website column such as `https://acme.com/x`. */
export function domainFromWebsite(value: string): string | null {
  const raw = value.trim().toLowerCase();
  if (!raw) return null;
  const withScheme = /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
  try {
    const host = new URL(withScheme).hostname.replace(/^www\./, '');
    return host.includes('.') ? host : null;
  } catch {
    return null;
  }
}

export class InternalDbClientSource implements ClientSource {
  async listClients(): Promise<ClientRecord[]> {
    const sql = config.internalDb.clientsQuery || DEFAULT_CLIENTS_QUERY;
    const rows = await readOnly(async (c) => (await c.query(sql)).rows);

    return rows.map((r: any) => {
      const domains = toList(r.domains);
      // A website column is a common stand-in for a domain list.
      if (r.website) {
        const d = domainFromWebsite(String(r.website));
        if (d) domains.push(d);
      }
      return {
        externalId: String(r.external_id ?? r.id),
        name: String(r.name),
        tier: r.tier ?? null,
        accountManagerEmail: r.account_manager_email?.toLowerCase() ?? null,
        domains: [...new Set(domains)],
        contacts: toList(r.contacts),
        slaHours: r.sla_hours ?? null,
      };
    });
  }
}

export interface EmployeeRecord {
  email: string;
  name: string | null;
  team: string | null;
  managerEmail: string | null;
}

const DEFAULT_EMPLOYEES_QUERY = `
  SELECT email, name, NULL::text AS team, NULL::text AS manager_email
    FROM employees
   WHERE COALESCE(email, '') <> ''
`;

/** Optional: employees and their teams, to keep the roster in sync. */
export async function listInternalEmployees(): Promise<EmployeeRecord[]> {
  const sql = config.internalDb.employeesQuery || DEFAULT_EMPLOYEES_QUERY;
  const rows = await readOnly(async (c) => (await c.query(sql)).rows);
  return rows
    .filter((r: any) => r.email)
    .map((r: any) => ({
      email: String(r.email).toLowerCase(),
      name: r.name ?? null,
      team: r.team ?? null,
      managerEmail: r.manager_email?.toLowerCase() ?? null,
    }));
}

export async function testInternalDb(): Promise<{ ok: boolean; error?: string; clients?: number; employees?: number }> {
  if (!config.internalDb.url) return { ok: false, error: 'INTERNAL_DB_URL is not set' };
  try {
    const clients = await new InternalDbClientSource().listClients();
    let employees = 0;
    try {
      employees = (await listInternalEmployees()).length;
    } catch {
      // Employees are optional; a missing table is not a failure.
    }
    return { ok: true, clients: clients.length, employees };
  } catch (err) {
    logger.error({ err }, 'internal db check failed');
    return { ok: false, error: String(err) };
  }
}
