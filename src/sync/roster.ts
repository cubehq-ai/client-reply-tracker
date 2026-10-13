import { query, tx } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { clearMailboxCache } from '../pipeline/ingest.js';

export interface RosterEntry {
  email: string;
  team: string;
  role?: 'member' | 'manager' | 'admin';
}

/**
 * The initial cubehq roster. This is a seed, not the source of truth — once
 * applied, mailboxes and teams are managed from Settings, and rows edited
 * there are marked `managed` so Directory discovery will not revert them.
 */
export const DEFAULT_ROSTER: RosterEntry[] = [
  { email: 'sahana.k@cubehq.ai', team: 'Admin', role: 'admin' },

  { email: 'vikyath@cubehq.ai', team: 'SEO' },
  { email: 'akanksha@cubehq.ai', team: 'SEO' },
  { email: 'devika@cubehq.ai', team: 'SEO' },
  { email: 'garima@cubehq.ai', team: 'SEO' },
  { email: 'jatin@cubehq.ai', team: 'SEO' },
  { email: 'khushi@cubehq.ai', team: 'SEO' },
  { email: 'muskaan@cubehq.ai', team: 'SEO' },
  { email: 'sagari@cubehq.ai', team: 'SEO' },
  { email: 'anna@cubehq.ai', team: 'SEO' },

  { email: 'aarushi@cubehq.ai', team: 'SEM' },
  { email: 'aayushi@cubehq.ai', team: 'SEM' },
  { email: 'iya@cubehq.ai', team: 'SEM' },
  { email: 'praveen@cubehq.ai', team: 'SEM' },
  { email: 'shashank.s@cubehq.ai', team: 'SEM' },
  { email: 'shubham@cubehq.ai', team: 'SEM' },
  { email: 'vishal@cubehq.ai', team: 'SEM' },

  { email: 'anishikar@cubehq.ai', team: 'Social' },
  { email: 'mary@cubehq.ai', team: 'Social' },
];

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

export async function upsertTeam(name: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `INSERT INTO teams (name, slug) VALUES ($1,$2)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name, slugify(name)],
  );
  return Number(rows[0]!.id);
}

export interface RosterResult {
  teams: number;
  mailboxes: number;
  added: string[];
}

/**
 * Registers each roster entry as an active, watched mailbox with its team.
 * Safe to re-run: existing rows keep their history and only gain the team.
 */
export async function applyRoster(roster: RosterEntry[] = DEFAULT_ROSTER): Promise<RosterResult> {
  const teamIds = new Map<string, number>();
  for (const team of new Set(roster.map((r) => r.team))) {
    teamIds.set(team, await upsertTeam(team));
  }

  const added: string[] = [];

  for (const entry of roster) {
    const email = entry.email.toLowerCase();
    const teamId = teamIds.get(entry.team)!;

    await tx(async (c) => {
      const userRes = await c.query<{ id: string; inserted: boolean }>(
        `INSERT INTO users (email, name, role, status, team_id)
         VALUES ($1,$2,$3,'active',$4)
         ON CONFLICT (email) DO UPDATE SET
           team_id = EXCLUDED.team_id,
           role = CASE WHEN users.role = 'member' THEN EXCLUDED.role ELSE users.role END,
           status = 'active',
           updated_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [email, email.split('@')[0], entry.role ?? 'member', teamId],
      );
      const userId = Number(userRes.rows[0]!.id);
      if (userRes.rows[0]!.inserted) added.push(email);

      await c.query(
        `INSERT INTO mailboxes (email, user_id, kind, status, team_id, managed, added_by)
         VALUES ($1,$2,'user','active',$3,true,'roster')
         ON CONFLICT (email) DO UPDATE SET
           user_id = EXCLUDED.user_id,
           team_id = EXCLUDED.team_id,
           status = 'active',
           managed = true,
           updated_at = now()`,
        [email, userId, teamId],
      );
    });
  }

  clearMailboxCache();
  logger.info({ teams: teamIds.size, mailboxes: roster.length, added: added.length }, 'roster applied');
  return { teams: teamIds.size, mailboxes: roster.length, added };
}
