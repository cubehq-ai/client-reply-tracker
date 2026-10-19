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
  website_access_id?: unknown;
  /** Team member who owns the account; tpl is the fallback. */
  npl_member_id?: string;
  tpl_member_id?: string;
  seo?: { gsc?: { site_url?: unknown }; ga4?: { name?: unknown }; gmc?: { name?: unknown } };
}

/** Pulls a bare hostname out of a url, an sc-domain: property or a label. */
export function hostFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let raw = value.trim().toLowerCase();
  if (!raw || raw.includes('@')) return null;

  // GA4 and GMC names look like "www.thinoptics.com - GA4".
  raw = raw.replace(/\s+-\s+(ga4|gmc|gsc|merchant.*)$/i, '').trim();
  raw = raw.replace(/^sc-domain:/, '');
  if (!/^https?:\/\//.test(raw)) raw = `https://${raw}`;

  try {
    const host = new URL(raw).hostname.replace(/^www\./, '');
    // Must look like a real registrable domain.
    if (!/^([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}$/.test(host)) return null;
    return host;
  } catch {
    return null;
  }
}

/**
 * Every place a client's own domain appears in the dashboard. Search Console
 * is the strongest of these: it is a verified property, not a guess.
 */
export function domainsFromClientDoc(doc: MongoClient): string[] {
  const out = [
    hostFrom(doc.seo?.gsc?.site_url),
    hostFrom(doc.seo?.ga4?.name),
    hostFrom(doc.seo?.gmc?.name),
    hostFrom(doc.website_access_id),
  ].filter((d): d is string => d !== null);
  return [...new Set(out)];
}

/** `service_type` is a list of services on the dashboard, not a single value. */
function serviceLabel(value: unknown): string | null {
  if (Array.isArray(value)) {
    const parts = value.map((v) => String(v).trim()).filter(Boolean);
    return parts.length ? parts.join(', ') : null;
  }
  const s = typeof value === 'string' ? value.trim() : '';
  return s || null;
}

async function freeDomainSet(): Promise<Set<string>> {
  const rows = await query<{ domain: string }>('SELECT domain FROM free_email_domains');
  return new Set(rows.map((r) => r.domain.toLowerCase()));
}

/** Reads the dashboard and works out which contacts and domains are safe to claim. */
export async function buildClientRecords(): Promise<{ records: ClientRecord[]; stats: ClientImportStats }> {
  const orgDomains = new Set(config.org.domains.map((d) => d.toLowerCase()));
  const free = await freeDomainSet();

  // Clients name their owner by team-member id; resolve those to addresses so
  // the account manager is known here too. It decides who owns mail sent to a
  // shared inbox, so it is not only a column in a table.
  const { docs, memberEmailById } = await withInternalDb(async (db) => {
    const clients = await db.collection('clients').find<MongoClient>({}, 1000);
    const members = await db.collection('team_members').find<{ id?: string; email?: string }>({}, 1000);
    const byId = new Map<string, string>();
    for (const m of members) {
      if (m.id && m.email) byId.set(m.id, m.email.trim().toLowerCase());
    }
    return { docs: clients, memberEmailById: byId };
  });

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

    // A domain can come from a contact address or from a connected property.
    const candidates = [
      ...contacts.map((e) => domainOf(e)),
      ...domainsFromClientDoc(doc),
    ];
    for (const d of candidates) {
      if (!d || free.has(d) || orgDomains.has(d)) continue;
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
    for (const d of [...contacts.map((e) => domainOf(e)), ...domainsFromClientDoc(doc)]) {
      if (!d || orgDomains.has(d)) continue;
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
      tier: serviceLabel(doc.service_type),
      accountManagerEmail:
        (doc.npl_member_id ? memberEmailById.get(doc.npl_member_id) : undefined) ??
        (doc.tpl_member_id ? memberEmailById.get(doc.tpl_member_id) : undefined) ??
        null,
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
  /** Newly seen people, within the prompt window and not yet watched. */
  newPeople: NewPerson[];
  /** Watched mailboxes whose person is no longer active in the dashboard. */
  paused: string[];
}

interface MongoMember {
  email?: string;
  name?: string;
  role?: string;
  is_active?: boolean;
}

/** How long a newly seen person stays on the Settings prompt. */
export const NEW_PERSON_WINDOW_DAYS = 14;

/**
 * Records everyone currently in the dashboard, so later runs can tell a new
 * joiner from the standing backlog.
 *
 * On the very first run everybody would look new, which is noise rather than a
 * prompt, so the initial population is backdated past the window.
 */
async function recordPeopleSeen(members: MongoMember[]): Promise<void> {
  const active = members.filter((m) => m.email && m.is_active !== false);
  if (active.length === 0) return;

  const existing = await query<{ n: string }>('SELECT count(*)::int AS n FROM internal_people_seen');
  const firstRun = Number(existing[0]?.n ?? 0) === 0;

  for (const m of active) {
    await query(
      `INSERT INTO internal_people_seen (email, name, role, first_seen_at, last_seen_at)
       VALUES ($1,$2,$3, now() - ($4 || ' days')::interval, now())
       ON CONFLICT (email) DO UPDATE SET
         name = EXCLUDED.name,
         role = EXCLUDED.role,
         last_seen_at = now()`,
      [
        m.email!.trim().toLowerCase(),
        m.name ?? null,
        (m.role ?? '').trim() || null,
        firstRun ? String(NEW_PERSON_WINDOW_DAYS + 1) : '0',
      ],
    );
  }
}

export interface NewPerson {
  email: string;
  name: string | null;
  role: string | null;
  firstSeenAt: string;
}

/**
 * People who appeared in the dashboard within the window and are not being
 * watched. Rows age out on their own, so an ignored prompt does not become a
 * permanent list nobody reads.
 */
export async function listNewPeople(): Promise<NewPerson[]> {
  const rows = await query<{ email: string; name: string | null; role: string | null; first_seen_at: Date }>(
    `SELECT p.email, p.name, p.role, p.first_seen_at
       FROM internal_people_seen p
      WHERE p.dismissed_at IS NULL
        AND p.first_seen_at > now() - ($1 || ' days')::interval
        AND NOT EXISTS (SELECT 1 FROM mailboxes mb WHERE mb.email = p.email)
      ORDER BY p.first_seen_at DESC, p.email`,
    [String(NEW_PERSON_WINDOW_DAYS)],
  );
  return rows.map((r) => ({
    email: r.email,
    name: r.name,
    role: r.role,
    firstSeenAt: r.first_seen_at.toISOString(),
  }));
}

/**
 * Everyone active in the dashboard who is not being watched, newest first.
 * Behind a toggle: it is a standing backlog rather than a prompt, but it is
 * the only way to reach someone who joined before this tool started.
 */
export async function listAllUnwatched(): Promise<NewPerson[]> {
  const rows = await query<{ email: string; name: string | null; role: string | null; first_seen_at: Date }>(
    `SELECT p.email, p.name, p.role, p.first_seen_at
       FROM internal_people_seen p
      WHERE p.dismissed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM mailboxes mb WHERE mb.email = p.email)
      ORDER BY p.role NULLS LAST, p.email`,
    [],
  );
  return rows.map((r) => ({
    email: r.email,
    name: r.name,
    role: r.role,
    firstSeenAt: r.first_seen_at.toISOString(),
  }));
}

export async function dismissNewPerson(email: string): Promise<void> {
  await query('UPDATE internal_people_seen SET dismissed_at = now() WHERE email = $1', [email.toLowerCase()]);
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

  await recordPeopleSeen(members);

  const watched = new Set(
    (await query<{ email: string }>("SELECT email FROM mailboxes WHERE status <> 'excluded'")).map((r) => r.email.toLowerCase()),
  );

  // A team chosen here outranks the dashboard role. Someone put a mailbox in
  // an Email Marketing team that exists only in this tool; the sync has no
  // business pulling it back to their dashboard role.
  const manual = new Set(
    (await query<{ email: string }>("SELECT email FROM mailboxes WHERE team_source = 'manual'"))
      .map((r) => r.email.toLowerCase()),
  );

  const teamIds = new Map<string, number>();
  let assigned = 0;

  const activeInDashboard = new Set<string>();

  for (const m of members) {
    const email = (m.email ?? '').trim().toLowerCase();
    const role = (m.role ?? '').trim();
    if (!email) continue;
    if (m.is_active !== false) activeInDashboard.add(email);

    if (!watched.has(email)) {
      // A new joiner is surfaced for an admin to add, never auto-watched.
      continue;
    }
    if (!role) continue;
    if (manual.has(email)) continue;
    if (!teamIds.has(role)) teamIds.set(role, await upsertTeam(role));
    const teamId = teamIds.get(role)!;

    await tx(async (c) => {
      await c.query(
        `UPDATE users SET team_id = $2, name = COALESCE($3, name), updated_at = now()
          WHERE email = $1 AND team_source <> 'manual'`,
        [email, teamId, m.name ?? null],
      );
      await c.query(
        "UPDATE mailboxes SET team_id = $2, updated_at = now() WHERE email = $1 AND team_source <> 'manual'",
        [email, teamId],
      );
    });
    assigned += 1;
  }

  // Someone who has left the dashboard should stop being read.
  const paused: string[] = [];
  for (const email of watched) {
    if (activeInDashboard.has(email)) continue;
    // Only pause people the dashboard knows about; shared inboxes and anyone
    // added by hand are left alone.
    const known = members.some((m) => (m.email ?? '').trim().toLowerCase() === email);
    if (!known) continue;
    const res = await query(
      "UPDATE mailboxes SET status = 'paused', updated_at = now() WHERE email = $1 AND status = 'active'",
      [email],
    );
    if ((res as unknown as { length: number }).length !== 0 || true) paused.push(email);
  }

  logger.info(
    { teams: teamIds.size, assigned, paused: paused.length },
    'team sync from internal dashboard complete',
  );
  return { teams: [...teamIds.keys()], assigned, newPeople: await listNewPeople(), paused };
}
