import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import {
  addClientDomain, addClientPattern, addMailbox, addMailboxesBulk, createClient,
  createTeam, listClientsDetailed, listMailboxes, listTeams, removeMailbox,
  testClientPattern, updateMailbox,
} from '../src/api/settings.js';
import type { SessionUser } from '../src/api/auth.js';
import { loadClientIndex, matchClient } from '../src/pipeline/clientMatch.js';
import { applyRoster } from '../src/sync/roster.js';
import { freshHarness, setupSchema, teardown } from './helpers.js';

const admin: SessionUser = { id: 1, email: 'dev@cubehq.ai', name: 'Dev', role: 'admin', canSendAsShared: true };

beforeAll(async () => { await setupSchema(); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await freshHarness();
  await query('TRUNCATE teams RESTART IDENTITY CASCADE');
});

describe('mailbox management', () => {
  it('adds a mailbox with a team and marks it managed', async () => {
    await addMailbox(admin, { email: 'New.Person@cubehq.ai', team: 'SEO' });
    const mailboxes = await listMailboxes();
    const added = mailboxes.find((m) => m.email === 'new.person@cubehq.ai');
    expect(added).toMatchObject({ status: 'active', managed: true, team_name: 'SEO' });
  });

  it('creates the matching user so the mailbox can own items immediately', async () => {
    await addMailbox(admin, { email: 'fresh@cubehq.ai', team: 'SEM' });
    const users = await query("SELECT email, status FROM users WHERE email = 'fresh@cubehq.ai'");
    expect(users[0]).toMatchObject({ status: 'active' });
  });

  it('rejects a malformed address', async () => {
    await expect(addMailbox(admin, { email: 'not-an-email' })).rejects.toThrow(/not a valid email/);
  });

  it('adds many at once and reports the rejects', async () => {
    const res = await addMailboxesBulk(admin, ['a@cubehq.ai', 'bad', 'b@cubehq.ai'], 'Social');
    expect(res.added).toEqual(['a@cubehq.ai', 'b@cubehq.ai']);
    expect(res.rejected).toHaveLength(1);
  });

  it('removing a mailbox excludes it but keeps its history', async () => {
    await addMailbox(admin, { email: 'leaver@cubehq.ai', team: 'SEO' });
    const before = (await listMailboxes()).find((m) => m.email === 'leaver@cubehq.ai');
    await removeMailbox(admin, Number(before.id));
    const after = (await listMailboxes()).find((m) => m.email === 'leaver@cubehq.ai');
    expect(after.status).toBe('excluded');
  });

  it('moves a mailbox and its user to another team', async () => {
    await addMailbox(admin, { email: 'mover@cubehq.ai', team: 'SEO' });
    const mb = (await listMailboxes()).find((m) => m.email === 'mover@cubehq.ai');
    await updateMailbox(admin, Number(mb.id), { team: 'SEM' });
    const after = (await listMailboxes()).find((m) => m.email === 'mover@cubehq.ai');
    expect(after.team_name).toBe('SEM');
    const user = await query("SELECT t.name FROM users u JOIN teams t ON t.id = u.team_id WHERE u.email = 'mover@cubehq.ai'");
    expect(user[0]!.name).toBe('SEM');
  });
});

describe('teams', () => {
  it('creates a team and counts its members', async () => {
    await createTeam(admin, 'Content');
    await addMailbox(admin, { email: 'writer@cubehq.ai', team: 'Content' });
    const teams = await listTeams();
    expect(teams.find((t) => t.name === 'Content')).toMatchObject({ members: 1, mailboxes: 1 });
  });

  it('is idempotent on a repeated name', async () => {
    const a = await createTeam(admin, 'Design');
    const b = await createTeam(admin, 'Design');
    expect(a.id).toBe(b.id);
  });
});

describe('roster', () => {
  it('registers the whole roster across its teams', async () => {
    const res = await applyRoster();
    expect(res.mailboxes).toBe(19);
    expect(res.teams).toBe(4);
    const teams = await listTeams();
    const byName = Object.fromEntries(teams.map((t) => [t.name, t.mailboxes]));
    expect(byName).toMatchObject({ Admin: 1, SEO: 9, SEM: 7, Social: 2 });
  });

  it('is safe to re-run', async () => {
    await applyRoster();
    await applyRoster();
    const mailboxes = await listMailboxes();
    expect(mailboxes.filter((m) => m.email.endsWith('@cubehq.ai')).length).toBeGreaterThanOrEqual(19);
  });
});

describe('clients and patterns', () => {
  it('creates a client with domains and matches mail from it', async () => {
    const client = await createClient(admin, { name: 'Initech', domains: ['initech.test'] });
    const index = await loadClientIndex();
    expect(matchClient(index, 'ops@initech.test')).toMatchObject({ clientId: client.id, matchedOn: 'domain' });
  });

  it('refuses a free provider domain but accepts a pattern for it', async () => {
    const client = await createClient(admin, { name: 'Hooli' });
    await expect(addClientDomain(admin, client.id, 'gmail.com')).rejects.toThrow(/free email provider/);
    await addClientPattern(admin, client.id, '^hooli\\..*@gmail\\.com$');
    const index = await loadClientIndex();
    expect(matchClient(index, 'hooli.ceo@gmail.com').clientId).toBe(client.id);
    expect(matchClient(index, 'someone@gmail.com').clientId).toBeNull();
  });

  it('rejects an invalid regex rather than storing it', async () => {
    const client = await createClient(admin, { name: 'Umbrella' });
    await expect(addClientPattern(admin, client.id, '([unclosed')).rejects.toThrow(/not a valid regular expression/);
  });

  it('tests a pattern against senders we have actually seen', async () => {
    const res = await testClientPattern('^.*@acme\\.com$');
    expect(res.valid).toBe(true);
    const bad = await testClientPattern('([unclosed');
    expect(bad.valid).toBe(false);
  });

  it('strips an @ and lowercases a pasted domain', async () => {
    const client = await createClient(admin, { name: 'Soylent' });
    await addClientDomain(admin, client.id, '@SOYLENT.TEST');
    const index = await loadClientIndex();
    expect(matchClient(index, 'ops@soylent.test').clientId).toBe(client.id);
  });
});

describe('client listing shape', () => {
  /**
   * A COALESCE onto an untyped '{}' loses the array type and node-pg hands
   * back a string. The UI then called .join on it, which threw during render
   * and unmounted the whole app — the Settings tabs appeared to stop working.
   */
  it('returns real arrays for domains, contacts and patterns', async () => {
    const client = await createClient(admin, { name: 'Arrayco', domains: ['arrayco.test'], contacts: ['ops@arrayco.test'] });
    await addClientPattern(admin, client.id, '^ops@arrayco\\.test$');

    const rows = await listClientsDetailed();
    const row = rows.find((r) => r.name === 'Arrayco');

    expect(Array.isArray(row.domains)).toBe(true);
    expect(Array.isArray(row.contacts)).toBe(true);
    expect(Array.isArray(row.patterns)).toBe(true);
    expect(row.domains).toContain('arrayco.test');
  });

  it('returns an empty array, not a string, for a client with nothing attached', async () => {
    await createClient(admin, { name: 'Bareco' });
    const row = (await listClientsDetailed()).find((r) => r.name === 'Bareco');
    expect(Array.isArray(row.domains)).toBe(true);
    expect(row.domains).toHaveLength(0);
    expect(Array.isArray(row.patterns)).toBe(true);
  });
});

describe('mailbox discovery without an admin subject', () => {
  it('skips rather than throwing, so the nightly job stops failing silently', async () => {
    const { config } = await import('../src/lib/config.js');
    const backend = config.google.backend;
    const subject = config.google.adminSubject;
    try {
      (config.google as any).backend = 'real';
      (config.google as any).adminSubject = '';
      const { discoverMailboxes } = await import('../src/sync/discovery.js');
      const r = await discoverMailboxes();
      expect(r.skipped).toBe('no_admin_subject');
      expect(r.mailboxesWatched).toBe(0);
    } finally {
      (config.google as any).backend = backend;
      (config.google as any).adminSubject = subject;
    }
  });
});
