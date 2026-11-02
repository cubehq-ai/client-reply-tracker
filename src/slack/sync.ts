import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { loadOrgContext } from '../pipeline/context.js';
import { matchClient } from '../pipeline/clientMatch.js';
import { domainOf } from '../pipeline/normalize.js';
import { getSlackClient, slackConfigured } from './index.js';
import type { SlackIdentity } from './types.js';

/**
 * The workspace the token belongs to, read rather than configured.
 *
 * The token is a test user's today and a shared account's later, so nothing
 * may hardcode who it is. Cached per process; a restart picks up a swap.
 */
let identity: SlackIdentity | null = null;

export async function slackIdentity(): Promise<SlackIdentity> {
  if (!identity) identity = await getSlackClient().authTest();
  return identity;
}

export function clearSlackIdentity(): void {
  identity = null;
}

/** Pulls the user directory so internal/external is a lookup, not a guess. */
export async function syncSlackUsers(): Promise<{ users: number; internal: number }> {
  if (!slackConfigured()) return { users: 0, internal: 0 };
  const client = getSlackClient();
  const me = await slackIdentity();
  const org = await loadOrgContext();

  let cursor: string | null = null;
  let count = 0;
  let internalCount = 0;

  do {
    const page = await client.listUsers(cursor);
    for (const u of page.items) {
      // Internal is either side of the same coin: our workspace, or an address
      // on an org domain (a guest account in our own team still counts).
      const email = u.email?.toLowerCase() ?? null;
      const isInternal = u.teamId === me.teamId || (email != null && org.orgDomains.has(domainOf(email)));
      await query(
        `INSERT INTO slack_users (id, team_id, email, name, is_internal, is_bot, deleted, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now())
         ON CONFLICT (id) DO UPDATE SET
           team_id = EXCLUDED.team_id, email = EXCLUDED.email, name = EXCLUDED.name,
           is_internal = EXCLUDED.is_internal, is_bot = EXCLUDED.is_bot,
           deleted = EXCLUDED.deleted, updated_at = now()`,
        [u.id, u.teamId, email, u.name, isInternal, u.isBot, u.deleted],
      );
      count += 1;
      if (isInternal) internalCount += 1;
    }
    cursor = page.cursor;
  } while (cursor);

  logger.info({ users: count, internal: internalCount }, 'slack users synced');
  return { users: count, internal: internalCount };
}

/**
 * Stores any of these users we do not already know.
 *
 * users.list covers our own workspace only. The people in a Slack Connect
 * channel belong to the client's workspace, so they never appear in it --
 * which is to say every external member, the ones the mapping depends on,
 * has to be fetched one at a time.
 */
export async function ensureSlackUsers(userIds: string[]): Promise<number> {
  if (userIds.length === 0) return 0;
  const known = await query<{ id: string }>('SELECT id FROM slack_users WHERE id = ANY($1::text[])', [userIds]);
  const missing = userIds.filter((id) => !known.some((k) => k.id === id));
  if (missing.length === 0) return 0;

  const client = getSlackClient();
  const me = await slackIdentity();
  const org = await loadOrgContext();
  let added = 0;

  for (const id of missing) {
    const u = await client.getUser(id);
    if (!u) continue;
    const email = u.email?.toLowerCase() ?? null;
    const isInternal = u.teamId === me.teamId || (email != null && org.orgDomains.has(domainOf(email)));
    await query(
      `INSERT INTO slack_users (id, team_id, email, name, is_internal, is_bot, deleted, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now())
       ON CONFLICT (id) DO UPDATE SET
         team_id = EXCLUDED.team_id, email = EXCLUDED.email, name = EXCLUDED.name,
         is_internal = EXCLUDED.is_internal, is_bot = EXCLUDED.is_bot,
         deleted = EXCLUDED.deleted, updated_at = now()`,
      [u.id, u.teamId, email, u.name, isInternal, u.isBot, u.deleted],
    );
    added += 1;
  }
  if (added > 0) logger.info({ added }, 'fetched slack users not in our workspace');
  return added;
}

export interface ChannelSyncResult {
  channels: number;
  /** Channels with an external human in them, mapped or not. */
  clientChannels: number;
  mapped: number;
  watched: number;
  unmapped: string[];
}

/**
 * Lists every channel we can read and decides, per channel, whether it is a
 * client conversation and whose.
 *
 * Two decisions, deliberately separate:
 *
 *   watched -- does a client talk to us here? Answered by whether any
 *     external human is in the channel. #general and #sentry-alerts-* have
 *     none; #reviews-california has twenty-nine.
 *   client_id -- which client? Best effort. The dashboard has no domain rows
 *     for most Slack-only accounts, so this stays null more often than not,
 *     and the item carries unmatched_client rather than disappearing.
 *
 * Tying the first to the second, as the first cut did, hid every channel
 * whose client the dashboard happens not to list -- 46 of 48 of them.
 */
export async function syncSlackChannels(): Promise<ChannelSyncResult> {
  if (!slackConfigured()) return { channels: 0, clientChannels: 0, mapped: 0, watched: 0, unmapped: [] };
  const client = getSlackClient();
  const org = await loadOrgContext();
  const clientNames = await loadClientNames();

  let cursor: string | null = null;
  let channels = 0;
  let clientChannels = 0;
  let mapped = 0;
  let watched = 0;
  const unmapped: string[] = [];

  do {
    const page = await client.listChannels(cursor);
    for (const ch of page.items) {
      if (ch.isArchived) continue;
      channels += 1;

      await query(
        `INSERT INTO slack_channels (id, name, is_private, is_shared, is_archived, updated_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, is_private = EXCLUDED.is_private,
           is_shared = EXCLUDED.is_shared, is_archived = EXCLUDED.is_archived, updated_at = now()`,
        [ch.id, ch.name, ch.isPrivate, ch.isShared, ch.isArchived],
      );

      const existing = await query<{ client_id: string | null; mapping_source: string; watch_source: string }>(
        'SELECT client_id, mapping_source, watch_source FROM slack_channels WHERE id = $1',
        [ch.id],
      );
      const row = existing[0]!;

      const members = await channelMembers(ch.id);
      const externals = await externalMembers(members);
      if (externals.length > 0) clientChannels += 1;

      await query(
        'UPDATE slack_channels SET member_count = $2, external_member_count = $3, updated_at = now() WHERE id = $1',
        [ch.id, members.length, externals.length],
      );

      // A person's mapping is never overwritten: they looked at the channel.
      let clientId = row.client_id == null ? null : Number(row.client_id);
      if (row.mapping_source !== 'manual') {
        const inferred = inferChannelClient(ch.name, externals, org, clientNames);
        clientId = inferred.clientId;
        await query(
          `UPDATE slack_channels SET client_id = $2, mapping_source = 'auto', mapping_basis = $3, updated_at = now()
            WHERE id = $1`,
          [ch.id, inferred.clientId, inferred.basis],
        );
      }
      if (clientId != null) mapped += 1;
      else if (externals.length > 0) unmapped.push(ch.name);

      // Watching follows the externals, and only while nobody has decided by
      // hand. A channel that loses its last external guest stops being work.
      if (row.watch_source !== 'manual') {
        await query('UPDATE slack_channels SET watched = $2, updated_at = now() WHERE id = $1',
          [ch.id, externals.length > 0]);
      }
      const after = await query<{ watched: boolean }>('SELECT watched FROM slack_channels WHERE id = $1', [ch.id]);
      if (after[0]?.watched) watched += 1;
    }
    cursor = page.cursor;
  } while (cursor);

  logger.info({ channels, clientChannels, mapped, watched, unmapped: unmapped.length }, 'slack channels synced');
  return { channels, clientChannels, mapped, watched, unmapped };
}

async function channelMembers(channelId: string): Promise<string[]> {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await getSlackClient().listMembers(channelId, cursor);
    ids.push(...page.items);
    cursor = page.cursor;
  } while (cursor);
  // The externals are exactly the people users.list does not return, so they
  // have to be fetched one at a time before any of this means anything.
  await ensureSlackUsers(ids);
  return ids;
}

async function externalMembers(memberIds: string[]): Promise<{ id: string; email: string | null }[]> {
  if (memberIds.length === 0) return [];
  return query<{ id: string; email: string | null }>(
    `SELECT id, email::text AS email FROM slack_users
      WHERE id = ANY($1::text[]) AND is_internal = false AND is_bot = false AND deleted = false`,
    [memberIds],
  );
}

interface ClientNameIndex {
  /** Slug of the client name -> client id. Ambiguous slugs are dropped. */
  bySlug: Map<string, number | null>;
}

async function loadClientNames(): Promise<ClientNameIndex> {
  const rows = await query<{ id: string; name: string }>('SELECT id, name FROM clients WHERE NOT archived');
  const bySlug = new Map<string, number | null>();
  for (const r of rows) {
    const key = slugify(r.name);
    if (key.length < 5) continue;
    // Two clients sharing a slug cannot be told apart by name, so neither wins.
    bySlug.set(key, bySlug.has(key) ? null : Number(r.id));
  }
  return { bySlug };
}

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Words in a channel name that say nothing about which client it is. */
const CHANNEL_NOISE = new Set(['cube', 'cubehq', 'x', 'cl', 'team', 'with', 'and', 'the']);

export interface ChannelMapping {
  clientId: number | null;
  /** How we got there, shown in Settings so a weak match reads as one. */
  basis: 'email' | 'email_domain_name' | 'channel_name' | null;
}

/**
 * Who a channel belongs to, strongest evidence first.
 *
 * 1. An external member's address maps to a client through client_domains or
 *    client_contacts -- the same table the mail side matches on.
 * 2. The registrable name in an external member's domain is a client's name:
 *    madeforfreedom.com is "Made for freedom". The dashboard is missing most
 *    of these domain rows, and the name is the same fact written differently.
 * 3. The channel name contains a client's name: #just-enough-wines-x-cube.
 *    Weakest, and last, because a channel can be named anything.
 *
 * Any step that implicates two clients is abandoned rather than guessed at:
 * filing one client's conversation under another's name is worse than
 * leaving it unmatched, which the UI already has a filter for.
 */
export function inferChannelClient(
  channelName: string,
  externals: { email: string | null }[],
  org: { clients: Parameters<typeof matchClient>[0] },
  names: ClientNameIndex,
): ChannelMapping {
  const emails = externals.map((e) => e.email).filter((e): e is string => e != null && e !== '');

  const byEmail = new Set<number>();
  for (const email of emails) {
    const m = matchClient(org.clients, email);
    if (m.clientId) byEmail.add(m.clientId);
  }
  if (byEmail.size === 1) return { clientId: [...byEmail][0]!, basis: 'email' };
  if (byEmail.size > 1) return { clientId: null, basis: null };

  const byDomainName = new Set<number>();
  for (const domain of new Set(emails.map((e) => domainOf(e)))) {
    if (org.clients.freeDomains.has(domain)) continue;
    // "mail.madeforfreedom.com" and "madeforfreedom.com" both give the label
    // one level above the public suffix a chance; co.uk makes the last two
    // unreliable, so the second-to-last and third-to-last are both tried.
    const parts = domain.split('.');
    for (const label of [parts[parts.length - 2], parts[parts.length - 3]]) {
      if (!label) continue;
      const hit = names.bySlug.get(slugify(label));
      if (hit) byDomainName.add(hit);
    }
  }
  if (byDomainName.size === 1) return { clientId: [...byDomainName][0]!, basis: 'email_domain_name' };
  if (byDomainName.size > 1) return { clientId: null, basis: null };

  const joined = channelName.toLowerCase().split(/[^a-z0-9]+/i)
    .filter((t) => t && !CHANNEL_NOISE.has(t)).join('');
  if (joined.length >= 5) {
    const byName = new Set<number>();
    for (const [slug, id] of names.bySlug) {
      if (id == null) continue;
      if (joined.includes(slug) || (slug.includes(joined) && joined.length >= slug.length - 2)) byName.add(id);
    }
    if (byName.size === 1) return { clientId: [...byName][0]!, basis: 'channel_name' };
  }

  return { clientId: null, basis: null };
}
