import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { slackEnabled } from '../lib/config.js';
import { loadOrgContext } from '../pipeline/context.js';
import { matchClient } from '../pipeline/clientMatch.js';
import { domainOf } from '../pipeline/normalize.js';
import { getSlackClient } from './index.js';
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
  if (!slackEnabled()) return { users: 0, internal: 0 };
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

export interface ChannelSyncResult {
  channels: number;
  mapped: number;
  unmapped: string[];
}

/**
 * Lists the channels the token owner is in and maps each to a client.
 *
 * Order matters: a manual mapping is never overwritten, because a person
 * chose it. Auto mapping reads the external members' email domains and
 * accepts only an unambiguous answer -- a channel whose externals belong to
 * two clients is left for a human rather than guessed at.
 */
export async function syncSlackChannels(): Promise<ChannelSyncResult> {
  if (!slackEnabled()) return { channels: 0, mapped: 0, unmapped: [] };
  const client = getSlackClient();
  const org = await loadOrgContext();

  let cursor: string | null = null;
  let channels = 0;
  let mapped = 0;
  const unmapped: string[] = [];

  do {
    const page = await client.listMemberChannels(cursor);
    for (const ch of page.items) {
      await query(
        `INSERT INTO slack_channels (id, name, is_private, is_shared, is_archived, updated_at)
         VALUES ($1,$2,$3,$4,$5, now())
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name, is_private = EXCLUDED.is_private,
           is_shared = EXCLUDED.is_shared, is_archived = EXCLUDED.is_archived, updated_at = now()`,
        [ch.id, ch.name, ch.isPrivate, ch.isShared, ch.isArchived],
      );
      channels += 1;

      const existing = await query<{ client_id: string | null; mapping_source: string }>(
        'SELECT client_id, mapping_source FROM slack_channels WHERE id = $1',
        [ch.id],
      );
      if (existing[0]?.mapping_source === 'manual') {
        if (existing[0].client_id) mapped += 1;
        continue;
      }

      const clientId = await inferChannelClient(ch.id, org);
      if (clientId) {
        await query(
          `UPDATE slack_channels
              SET client_id = $2, mapping_source = 'auto',
                  -- A mapped channel is worth watching; a person can still
                  -- turn it off in Settings and that choice survives, because
                  -- watched is only defaulted when the mapping first lands.
                  watched = CASE WHEN client_id IS DISTINCT FROM $2 THEN true ELSE watched END,
                  updated_at = now()
            WHERE id = $1`,
          [ch.id, clientId],
        );
        mapped += 1;
      } else {
        unmapped.push(ch.name);
      }
    }
    cursor = page.cursor;
  } while (cursor);

  logger.info({ channels, mapped, unmapped: unmapped.length }, 'slack channels synced');
  return { channels, mapped, unmapped };
}

/**
 * Reads the external members of a channel and maps them to a client. Returns
 * null unless exactly one client is implicated.
 */
async function inferChannelClient(
  channelId: string,
  org: Awaited<ReturnType<typeof loadOrgContext>>,
): Promise<number | null> {
  const memberIds: string[] = [];
  let cursor: string | null = null;
  do {
    const page = await getSlackClient().listMembers(channelId, cursor);
    memberIds.push(...page.items);
    cursor = page.cursor;
  } while (cursor);

  if (memberIds.length === 0) return null;

  const externals = await query<{ email: string }>(
    `SELECT DISTINCT email FROM slack_users
      WHERE id = ANY($1::text[]) AND is_internal = false AND is_bot = false
        AND deleted = false AND email IS NOT NULL`,
    [memberIds],
  );

  const found = new Set<number>();
  for (const row of externals) {
    const match = matchClient(org.clients, row.email);
    if (match.clientId) found.add(match.clientId);
  }
  // Several clients in one channel is ambiguous, and picking one silently
  // would file another client's messages under the wrong name.
  return found.size === 1 ? [...found][0]! : null;
}
