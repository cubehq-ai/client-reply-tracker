import { query, tx } from '../db/pool.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';
import { domainOf } from '../pipeline/normalize.js';
import type { ClientRecord, ClientSource } from './clients.js';
import { withInternalDb } from './internalMongo.js';
import { upsertTeam } from './roster.js';

/**
 * Maps the internal agency dashboard (MongoDB) onto this tool's model.
 *
 * The dashboard has no client-domain field. What it does have is
 * `clients.notification_emails`, which mixes our own staff with the client's
 * actual contacts. Every external address in there is a real client contact,
 * and its domain is a candidate client domain.
 *
 * Domains are only claimed when they belong to exactly one client: several
 * clients legitimately share one (a restaurant group, a parent company), and
 * claiming a shared domain would silently file one client's mail under
 * another. Shared domains are reported instead, and their individual
 * addresses still map exactly.
 *
 * All of this is lookup and set logic. No model is involved.
 */

export interface ClientImportStats {
  clients: number;
  churned: number;
  contacts: number;
  domains: number;
  sharedDomains: { domain: string; clients: string[] }[];
  freeDomainsSkipped: string[];
}

interface MongoClient {
  _id: unknown;
  id?: string;
  name?: string;
  slug?: string;
  service_type?: string;
  is_active?: boolean;
  is_churned?: boolean;
  notification_emails?: unknown;
}

async function freeDomainSet(): Promise<Set<string>> {
  const rows = await query<{ domain: string }>('SELECT domain FROM free_email_domains');
  return new Set(rows.map((r) => r.domain.toLowerCase()));
}

/** Reads the dashboard and works out which contacts and domains are safe to claim. */
export async function buildClientRecords(): Promise<{ records: ClientRecord[]; stats: ClientImportStats }> {
  const orgDomains = new Set(config.org.domains.map((d) => d.toLowerCase()));
  const free = await freeDomainSet();

  const docs = await withInternalDb(async (db) => db.collection('clients').find<MongoClient>({}, 1000));

  // First pass: which client(s) does each external domain belong to?
  const domainOwners = new Map<string, Set<string>>();
  const perClient = new Map<string, { doc: MongoClient; contacts: string[] }>();

  for (const doc of docs) {
    const name = (doc.name ?? '').trim();
    if (!name) continue;
    const key = String(doc.id ?? doc.slug ?? doc._id);

    const emails = Array.isArray(doc.notification_emails) ? doc.notification_emails : [];
    const contacts = emails
      .filter((e): e is string => typeof e === 'string' && e.includes('@'))
      .map((e) => e.trim().toLowerCase())
      // Our own staff are on these lists; they are not client contacts.
      .filter((e) => !orgDomains.has(domainOf(e)));

    perClient.set(key, { doc, contacts });

    for (const email of contacts) {
      const d = domainOf(email);
      if (!d || free.has(d)) continue;
      const owners = domainOwners.get(d) ?? new Set<string>();
      owners.add(name);
      domainOwners.set(d, owners);
    }
  }

  const sharedDomains: ClientImportStats['sharedDomains'] = [];
  for (const [domain, owners] of domainOwners) {
    if (owners.size > 1) sharedDomains.push({ domain, clients: [...owners] });
  }
  const ambiguous = new Set(sharedDomains.map((s) => s.domain));

  const records: ClientRecord[] = [];
  const freeDomainsSkipped = new Set<string>();
  let churned = 0;
  let contactCount = 0;
  let domainCount = 0;

  for (const [key, { doc, contacts }] of perClient) {
    if (doc.is_churned) churned += 1;

    const domains: string[] = [];
    for (const email of contacts) {
      const d = domainOf(email);
      if (!d) continue;
      if (free.has(d)) { freeDomainsSkipped.add(d); continue; }
      // Only an unambiguous domain may stand for the whole client.
      if (ambiguous.has(d)) continue;
      if (!domains.includes(d)) domains.push(d);
    }

    contactCount += contacts.length;
    domainCount += domains.length;

    records.push({
      externalId: `agency:${key}`,
      name: (doc.name ?? '').trim(),
      tier: doc.service_type ?? null,
      accountManagerEmail: null,
      domains,
      // Exact addresses always map, including on a shared or free domain.
      contacts,
    });
  }

  return {
    records,
    stats: {
      clients: records.length,
      churned,
      contacts: contactCount,
      domains: domainCount,
      sharedDomains,
      freeDomainsSkipped: [...freeDomainsSkipped],
    },
  };
}

/** ClientSource backed by the internal dashboard. */
export class AgencyDashboardClientSource implements ClientSource {
  async listClients(): Promise<ClientRecord[]> {
    return (await buildClientRecords()).records;
  }
}

/** Marks churned clients archived so they drop out of the active views. */
export async function markChurnedClients(): Promise<number> {
  const docs = await withInternalDb(async (db) =>
    db.collection('clients').find<MongoClient>({ is_churned: true }, 1000),
  );
  const ids = docs.map((d) => `agency:${String(d.id ?? d.slug ?? d._id)}`);
  if (ids.length === 0) return 0;
  const rows = await query<{ id: string }>(
    'UPDATE clients SET archived = true WHERE external_id = ANY($1::text[]) AND archived = false RETURNING id',
    [ids],
  );
  return rows.length;
}

export interface TeamSyncStats {
  teams: string[];
  assigned: number;
  unknownMailboxes: string[];
}

interface MongoMember {
  email?: string;
  name?: string;
  role?: string;
  is_active?: boolean;
}

/**
 * Takes team membership from the dashboard's `team_members.role`.
 *
 * Only mailboxes already on the watch list are touched: the dashboard knows
 * about 109 people, and silently starting to read all of their mail because
 * they appear in a table would be well beyond what was asked for.
 */
export async function syncTeamsFromInternal(): Promise<TeamSyncStats> {
  const members = await withInternalDb(async (db) => db.collection('team_members').find<MongoMember>({}, 1000));

  const watched = new Set(
    (await query<{ email: string }>("SELECT email FROM mailboxes WHERE status <> 'excluded'")).map((r) => r.email.toLowerCase()),
  );

  const teamIds = new Map<string, number>();
  let assigned = 0;
  const unknownMailboxes: string[] = [];

  for (const m of members) {
    const email = (m.email ?? '').trim().toLowerCase();
    const role = (m.role ?? '').trim();
    if (!email || !role) continue;
    if (!watched.has(email)) {
      unknownMailboxes.push(email);
      continue;
    }
    if (!teamIds.has(role)) teamIds.set(role, await upsertTeam(role));
    const teamId = teamIds.get(role)!;

    await tx(async (c) => {
      await c.query('UPDATE users SET team_id = $2, name = COALESCE($3, name), updated_at = now() WHERE email = $1', [
        email, teamId, m.name ?? null,
      ]);
      await c.query('UPDATE mailboxes SET team_id = $2, updated_at = now() WHERE email = $1', [email, teamId]);
    });
    assigned += 1;
  }

  logger.info({ teams: teamIds.size, assigned, notWatched: unknownMailboxes.length }, 'team sync from internal dashboard complete');
  return { teams: [...teamIds.keys()], assigned, unknownMailboxes };
}
