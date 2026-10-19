import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { addMailbox, createTeam, listMailboxes, updateMailbox } from '../src/api/settings.js';
import type { SessionUser } from '../src/api/auth.js';
import { freshHarness, setupSchema, teardown } from './helpers.js';

const admin: SessionUser = { id: 1, email: 'dev@cubehq.ai', name: 'Dev', role: 'admin', canSendAsShared: true };

/** The part of the dashboard sync that reassigns a team. */
async function dashboardAssigns(email: string, team: string): Promise<void> {
  const t = await createTeam(admin, team);
  await query(
    "UPDATE mailboxes SET team_id = $2 WHERE email = $1 AND team_source <> 'manual'",
    [email, t.id],
  );
  await query(
    "UPDATE users SET team_id = $2 WHERE email = $1 AND team_source <> 'manual'",
    [email, t.id],
  );
}

const teamOf = async (email: string) =>
  (await listMailboxes()).find((m) => m.email === email)?.team_name ?? null;

beforeAll(async () => { await setupSchema(); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await freshHarness();
  await query('TRUNCATE teams RESTART IDENTITY CASCADE');
});

describe('who decides a mailbox team', () => {
  it('keeps a team chosen here when the dashboard says otherwise', async () => {
    await addMailbox(admin, { email: 'craig@cubehq.ai', team: 'Email Marketing' });
    await dashboardAssigns('craig@cubehq.ai', 'CMS');
    expect(await teamOf('craig@cubehq.ai')).toBe('Email Marketing');
  });

  it('lets the dashboard assign a mailbox that was never set by hand', async () => {
    await addMailbox(admin, { email: 'auto@cubehq.ai' });
    await dashboardAssigns('auto@cubehq.ai', 'SEO');
    expect(await teamOf('auto@cubehq.ai')).toBe('SEO');
  });

  it('marks a team manual when it is changed here afterwards', async () => {
    await addMailbox(admin, { email: 'moved@cubehq.ai' });
    const mb = (await listMailboxes()).find((m) => m.email === 'moved@cubehq.ai');
    await updateMailbox(admin, Number(mb.id), { team: 'Email Marketing' });
    await dashboardAssigns('moved@cubehq.ai', 'Paid Ads');
    expect(await teamOf('moved@cubehq.ai')).toBe('Email Marketing');
  });

  it('keeps the user record in step with the mailbox', async () => {
    await addMailbox(admin, { email: 'sync@cubehq.ai', team: 'Email Marketing' });
    await dashboardAssigns('sync@cubehq.ai', 'CMS');
    const rows = await query<{ name: string }>(
      'SELECT t.name FROM users u JOIN teams t ON t.id = u.team_id WHERE u.email = $1',
      ['sync@cubehq.ai'],
    );
    expect(rows[0]?.name).toBe('Email Marketing');
  });
});
