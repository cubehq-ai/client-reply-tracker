import { one, query, tx } from '../db/pool.js';
import { invalidateOrgContext } from '../pipeline/context.js';
import { logger } from '../lib/logger.js';
import { clearMailboxCache } from '../pipeline/ingest.js';
import { rematchUnmatchedItems } from '../sync/clients.js';
import { upsertTeam } from '../sync/roster.js';
import { stopWatch } from '../sync/watch.js';
import { audit } from './actions.js';
import { HttpError, type SessionUser } from './auth.js';

// ---------- teams ----------

export async function listTeams(): Promise<any[]> {
  return query(
    `SELECT t.id, t.name, t.slug,
            count(DISTINCT u.id)::int AS members,
            count(DISTINCT mb.id)::int AS mailboxes
       FROM teams t
       LEFT JOIN users u ON u.team_id = t.id AND u.status = 'active'
       LEFT JOIN mailboxes mb ON mb.team_id = t.id
      GROUP BY t.id, t.name, t.slug
      ORDER BY t.name`,
  );
}

export async function createTeam(user: SessionUser, name: string): Promise<{ id: number; name: string }> {
  const trimmed = name.trim();
  if (!trimmed) throw new HttpError(400, 'a team name is required');
  const id = await upsertTeam(trimmed);
  await audit(user, 'create_team', null, { name: trimmed });
  return { id, name: trimmed };
}

export async function renameTeam(user: SessionUser, teamId: number, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) throw new HttpError(400, 'a team name is required');
  await query('UPDATE teams SET name = $2 WHERE id = $1', [teamId, trimmed]);
  await audit(user, 'rename_team', null, { teamId, name: trimmed });
}

export async function deleteTeam(user: SessionUser, teamId: number): Promise<void> {
  // Members and mailboxes survive; they simply lose the team.
  await query('DELETE FROM teams WHERE id = $1', [teamId]);
  await audit(user, 'delete_team', null, { teamId });
}

// ---------- mailboxes ----------

export async function listMailboxes(): Promise<any[]> {
  return query(
    `SELECT mb.id, mb.email, mb.kind, mb.status, mb.managed, mb.added_by,
            mb.last_synced_at, mb.watch_expiration, mb.last_error,
            t.id AS team_id, t.name AS team_name,
            u.role,
            (SELECT count(*)::int FROM message_copies mc WHERE mc.mailbox_id = mb.id) AS message_count
       FROM mailboxes mb
       LEFT JOIN teams t ON t.id = mb.team_id
       LEFT JOIN users u ON u.id = mb.user_id
      ORDER BY t.name NULLS LAST, mb.email`,
  );
}

export interface AddMailboxInput {
  email: string;
  team?: string | null;
  kind?: 'user' | 'shared';
  role?: 'member' | 'manager' | 'admin';
}

/**
 * Adds a mailbox to the watch list. Creates the matching user row so the
 * mailbox can own items immediately, before Directory discovery next runs.
 */
export async function addMailbox(user: SessionUser, input: AddMailboxInput): Promise<{ email: string; teamId: number | null }> {
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, `not a valid email address: ${input.email}`);

  const teamId = input.team ? await upsertTeam(input.team.trim()) : null;

  await tx(async (c) => {
    const userRes = await c.query<{ id: string }>(
      `INSERT INTO users (email, name, role, status, team_id)
       VALUES ($1,$2,$3,'active',$4)
       ON CONFLICT (email) DO UPDATE SET
         status = 'active',
         team_id = COALESCE(EXCLUDED.team_id, users.team_id),
         updated_at = now()
       RETURNING id`,
      [email, email.split('@')[0], input.role ?? 'member', teamId],
    );
    await c.query(
      `INSERT INTO mailboxes (email, user_id, kind, status, team_id, managed, added_by)
       VALUES ($1,$2,$3,'active',$4,true,$5)
       ON CONFLICT (email) DO UPDATE SET
         kind = EXCLUDED.kind,
         status = 'active',
         team_id = COALESCE(EXCLUDED.team_id, mailboxes.team_id),
         managed = true,
         updated_at = now()`,
      [email, Number(userRes.rows[0]!.id), input.kind ?? 'user', teamId, user.email],
    );
  });

  clearMailboxCache();
  invalidateOrgContext();
  await audit(user, 'add_mailbox', null, { email, team: input.team ?? null });
  logger.info({ email, team: input.team }, 'mailbox added to the watch list');
  return { email, teamId };
}

export async function updateMailbox(
  user: SessionUser,
  mailboxId: number,
  patch: { team?: string | null; status?: 'active' | 'paused' | 'excluded'; kind?: 'user' | 'shared' },
): Promise<void> {
  const teamId = patch.team === undefined ? undefined : patch.team === null ? null : await upsertTeam(patch.team.trim());

  const mailbox = await one<{ email: string }>('SELECT email FROM mailboxes WHERE id = $1', [mailboxId]);
  if (!mailbox) throw new HttpError(404, 'mailbox not found');

  await query(
    `UPDATE mailboxes SET
       team_id = CASE WHEN $2::boolean THEN $3 ELSE team_id END,
       status  = COALESCE($4, status),
       kind    = COALESCE($5, kind),
       managed = true,
       updated_at = now()
     WHERE id = $1`,
    [mailboxId, teamId !== undefined, teamId ?? null, patch.status ?? null, patch.kind ?? null],
  );

  if (teamId !== undefined) {
    await query('UPDATE users SET team_id = $2, updated_at = now() WHERE email = $1', [mailbox.email, teamId]);
  }
  // Stop consuming Gmail quota for a mailbox we no longer watch.
  if (patch.status && patch.status !== 'active') await stopWatch(mailbox.email);

  clearMailboxCache();
  invalidateOrgContext();
  await audit(user, 'update_mailbox', null, { mailboxId, ...patch });
}

/**
 * Removes a mailbox from the watch list. Ingested history is kept, because
 * deleting it would silently drop items other mailboxes still share.
 */
export async function removeMailbox(user: SessionUser, mailboxId: number): Promise<{ email: string }> {
  const mailbox = await one<{ email: string }>('SELECT email FROM mailboxes WHERE id = $1', [mailboxId]);
  if (!mailbox) throw new HttpError(404, 'mailbox not found');

  await query("UPDATE mailboxes SET status = 'excluded', managed = true, updated_at = now() WHERE id = $1", [mailboxId]);
  await stopWatch(mailbox.email);
  clearMailboxCache();
  invalidateOrgContext();
  await audit(user, 'remove_mailbox', null, { mailboxId, email: mailbox.email });
  return { email: mailbox.email };
}

/** Bulk add, for pasting a list of addresses. */
export async function addMailboxesBulk(
  user: SessionUser,
  emails: string[],
  team?: string | null,
): Promise<{ added: string[]; rejected: { email: string; reason: string }[] }> {
  const added: string[] = [];
  const rejected: { email: string; reason: string }[] = [];
  for (const raw of emails) {
    const email = raw.trim().toLowerCase();
    if (!email) continue;
    try {
      await addMailbox(user, { email, team });
      added.push(email);
    } catch (err) {
      rejected.push({ email, reason: err instanceof HttpError ? err.message : String(err) });
    }
  }
  return { added, rejected };
}

// ---------- clients, domains, patterns ----------

export async function listClientsDetailed(): Promise<any[]> {
  return query(
    `SELECT c.id, c.name, c.tier, c.external_id, c.archived,
            u.email AS account_manager,
            COALESCE(array_agg(DISTINCT d.domain) FILTER (WHERE d.domain IS NOT NULL), '{}'::text[]) AS domains,
            COALESCE(array_agg(DISTINCT ct.email) FILTER (WHERE ct.email IS NOT NULL), '{}'::text[]) AS contacts,
            COALESCE(json_agg(DISTINCT jsonb_build_object('id', p.id, 'pattern', p.pattern, 'priority', p.priority))
                     FILTER (WHERE p.id IS NOT NULL), '[]'::json) AS patterns
       FROM clients c
       LEFT JOIN users u ON u.id = c.account_manager_user_id
       LEFT JOIN client_domains d ON d.client_id = c.id
       LEFT JOIN client_contacts ct ON ct.client_id = c.id
       LEFT JOIN client_patterns p ON p.client_id = c.id
      GROUP BY c.id, c.name, c.tier, c.external_id, c.archived, u.email
      ORDER BY c.name`,
  );
}

export async function createClient(
  user: SessionUser,
  input: { name: string; tier?: string | null; domains?: string[]; contacts?: string[]; accountManagerEmail?: string | null },
): Promise<{ id: number; name: string; rejectedDomains: string[] }> {
  const name = input.name.trim();
  if (!name) throw new HttpError(400, 'a client name is required');

  const amId = input.accountManagerEmail
    ? (await one<{ id: string }>('SELECT id FROM users WHERE email = $1', [input.accountManagerEmail.toLowerCase()]))?.id
    : null;

  const clientRes = await query<{ id: string }>(
    `INSERT INTO clients (name, tier, account_manager_user_id, external_id)
     VALUES ($1,$2,$3,$4) RETURNING id`,
    [name, input.tier ?? null, amId ? Number(amId) : null, `manual:${name.toLowerCase().replace(/\s+/g, '-')}`],
  );
  const clientId = Number(clientRes[0]!.id);

  const rejectedDomains: string[] = [];
  for (const domain of input.domains ?? []) {
    try {
      await addClientDomain(user, clientId, domain);
    } catch {
      rejectedDomains.push(domain);
    }
  }
  for (const email of input.contacts ?? []) {
    await query(
      `INSERT INTO client_contacts (client_id, email, source) VALUES ($1,$2,'manual')
       ON CONFLICT (email) DO UPDATE SET client_id = EXCLUDED.client_id`,
      [clientId, email.trim().toLowerCase()],
    );
  }

  await rematchUnmatchedItems();
  invalidateOrgContext();
  await audit(user, 'create_client', null, { clientId, name });
  return { id: clientId, name, rejectedDomains };
}

export async function addClientDomain(user: SessionUser, clientId: number, domain: string): Promise<void> {
  const d = domain.trim().toLowerCase().replace(/^@/, '');
  if (!d.includes('.')) throw new HttpError(400, `not a valid domain: ${domain}`);
  // A free provider domain would claim every personal address on it.
  if (await one('SELECT 1 FROM free_email_domains WHERE domain = $1', [d])) {
    throw new HttpError(400, `${d} is a free email provider; add the specific address as a contact instead`);
  }
  await query(
    `INSERT INTO client_domains (client_id, domain, source) VALUES ($1,$2,'manual')
     ON CONFLICT (domain) DO UPDATE SET client_id = EXCLUDED.client_id`,
    [clientId, d],
  );
  await rematchUnmatchedItems();
  invalidateOrgContext();
  await audit(user, 'add_client_domain', null, { clientId, domain: d });
}

export async function removeClientDomain(user: SessionUser, domainId: number): Promise<void> {
  await query('DELETE FROM client_domains WHERE id = $1', [domainId]);
  await audit(user, 'remove_client_domain', null, { domainId });
}

export async function addClientPattern(
  user: SessionUser,
  clientId: number,
  pattern: string,
  priority = 100,
  note?: string,
): Promise<void> {
  try {
    new RegExp(pattern, 'i');
  } catch (err) {
    throw new HttpError(400, `not a valid regular expression: ${String(err)}`);
  }
  await query(
    `INSERT INTO client_patterns (client_id, pattern, priority, note, created_by)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (client_id, pattern) DO UPDATE SET priority = EXCLUDED.priority, note = EXCLUDED.note`,
    [clientId, pattern, priority, note ?? null, user.email],
  );
  await rematchUnmatchedItems();
  invalidateOrgContext();
  await audit(user, 'add_client_pattern', null, { clientId, pattern });
}

export async function removeClientPattern(user: SessionUser, patternId: number): Promise<void> {
  await query('DELETE FROM client_patterns WHERE id = $1', [patternId]);
  await audit(user, 'remove_client_pattern', null, { patternId });
}

/** Tests a regex against the unmatched senders we have actually seen. */
export async function testClientPattern(pattern: string): Promise<{ valid: boolean; error?: string; matches: string[] }> {
  let re: RegExp;
  try {
    re = new RegExp(pattern, 'i');
  } catch (err) {
    return { valid: false, error: String(err), matches: [] };
  }
  const senders = await query<{ from_email: string }>(
    `SELECT DISTINCT m.from_email FROM messages m
       JOIN items i ON i.conversation_id = m.conversation_id
      WHERE m.direction = 'in' AND i.client_id IS NULL
      LIMIT 500`,
  );
  return { valid: true, matches: senders.map((s) => s.from_email).filter((e) => re.test(e)).slice(0, 50) };
}

/** Strips everything but letters and digits, for comparing a name to a domain. */
function normaliseLabel(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Suggests a client for an unmatched sender by comparing the domain's
 * registrable label to the client's slug and name: daryl@norbot.ca against the
 * client "Norbot". It is only ever a suggestion — a one-click confirmation,
 * never an automatic claim, because a name collision with a vendor is easy.
 */
export async function suggestClientsForDomains(domains: string[]): Promise<Map<string, { id: number; name: string }>> {
  const out = new Map<string, { id: number; name: string }>();
  if (domains.length === 0) return out;

  const clients = await query<{ id: string; name: string; slug: string | null }>(
    'SELECT c.id, c.name, NULL AS slug FROM clients c WHERE c.archived = false',
  );
  const byLabel = new Map<string, { id: number; name: string }>();
  const ambiguous = new Set<string>();
  for (const c of clients) {
    for (const candidate of [c.name, c.slug ?? '']) {
      const label = normaliseLabel(candidate);
      if (label.length < 4) continue;
      if (byLabel.has(label) && byLabel.get(label)!.id !== Number(c.id)) { ambiguous.add(label); continue; }
      byLabel.set(label, { id: Number(c.id), name: c.name });
    }
  }

  for (const domain of domains) {
    // Compare against the registrable label: norbot.ca -> norbot
    const label = normaliseLabel(domain.split('.')[0] ?? '');
    if (label.length < 4 || ambiguous.has(label)) continue;
    const hit = byLabel.get(label);
    if (hit) out.set(domain, hit);
  }
  return out;
}

/** Senders we could not map, most frequent first — the Unmatched work list. */
export async function unmatchedSenders(): Promise<any[]> {
  const rows = await query<any>(
    `SELECT m.from_email, m.from_domain,
            count(DISTINCT i.id)::int AS items,
            MAX(m.internal_date) AS last_seen
       FROM messages m
       JOIN items i ON i.conversation_id = m.conversation_id
      WHERE m.direction = 'in' AND i.client_id IS NULL AND i.state <> 'archived'
      GROUP BY m.from_email, m.from_domain
      ORDER BY items DESC, last_seen DESC
      LIMIT 200`,
  );

  const suggestions = await suggestClientsForDomains([...new Set(rows.map((r) => r.from_domain).filter(Boolean))]);
  return rows.map((r) => ({ ...r, suggestion: suggestions.get(r.from_domain) ?? null }));
}

/**
 * Links every unmatched domain that has a confident name match. Each link is
 * the same operation a human would perform from the Unmatched list, applied in
 * bulk; free-provider domains are refused as always.
 */
export async function applyDomainSuggestions(user: SessionUser): Promise<{ linked: { domain: string; client: string }[]; skipped: string[] }> {
  const rows = await unmatchedSenders();
  const linked: { domain: string; client: string }[] = [];
  const skipped: string[] = [];
  const done = new Set<string>();

  for (const row of rows) {
    const domain: string | null = row.from_domain ?? null;
    if (!domain || !row.suggestion || done.has(domain)) continue;
    done.add(domain);
    try {
      await addClientDomain(user, row.suggestion.id, domain);
      linked.push({ domain, client: row.suggestion.name });
    } catch {
      skipped.push(domain);
    }
  }

  await rematchUnmatchedItems();
  logger.info({ linked: linked.length, skipped: skipped.length }, 'applied domain suggestions');
  return { linked, skipped };
}

// ---------- saved views ----------

export async function listSavedViews(user: SessionUser): Promise<any[]> {
  return query(
    `SELECT id, name, filters, shared, position FROM saved_views
      WHERE owner_email = $1 OR shared = true
      ORDER BY position, name`,
    [user.email],
  );
}

export async function createSavedView(user: SessionUser, name: string, filters: unknown, shared = false): Promise<{ id: number }> {
  const trimmed = name.trim();
  if (!trimmed) throw new HttpError(400, 'a view name is required');
  const rows = await query<{ id: string }>(
    `INSERT INTO saved_views (name, owner_email, filters, shared) VALUES ($1,$2,$3,$4)
     ON CONFLICT (owner_email, name) DO UPDATE SET filters = EXCLUDED.filters, shared = EXCLUDED.shared
     RETURNING id`,
    [trimmed, user.email, JSON.stringify(filters ?? {}), shared],
  );
  return { id: Number(rows[0]!.id) };
}

export async function deleteSavedView(user: SessionUser, viewId: number): Promise<void> {
  await query('DELETE FROM saved_views WHERE id = $1 AND owner_email = $2', [viewId, user.email]);
}
