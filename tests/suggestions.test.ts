import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { createClient, suggestClientsForDomains } from '../src/api/settings.js';
import type { SessionUser } from '../src/api/auth.js';
import { freshHarness, setupSchema, teardown } from './helpers.js';

const admin: SessionUser = { id: 1, email: 'dev@cubehq.ai', name: 'Dev', role: 'admin', canSendAsShared: true };

beforeAll(async () => { await setupSchema(); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await freshHarness();
  await query('TRUNCATE clients RESTART IDENTITY CASCADE');
});

describe('client suggestions for unmatched domains', () => {
  it('matches a domain label to a client name', async () => {
    const c = await createClient(admin, { name: 'Norbot' });
    const s = await suggestClientsForDomains(['norbot.ca']);
    expect(s.get('norbot.ca')).toMatchObject({ id: c.id, name: 'Norbot' });
  });

  it('ignores spaces and punctuation in the client name', async () => {
    await createClient(admin, { name: 'Planted Detroit' });
    await createClient(admin, { name: 'Mount-It' });
    const s = await suggestClientsForDomains(['planteddetroit.com', 'mount-it.com']);
    expect(s.get('planteddetroit.com')?.name).toBe('Planted Detroit');
    expect(s.get('mount-it.com')?.name).toBe('Mount-It');
  });

  it('suggests nothing when no client resembles the domain', async () => {
    await createClient(admin, { name: 'Norbot' });
    expect(await suggestClientsForDomains(['randomvendor.com'])).toEqual(new Map());
  });

  it('refuses to guess when two clients share the same label', async () => {
    await createClient(admin, { name: 'Acme' });
    await createClient(admin, { name: 'A.C.M.E.' });
    expect((await suggestClientsForDomains(['acme.com'])).size).toBe(0);
  });

  it('ignores labels too short to be meaningful', async () => {
    await createClient(admin, { name: 'ACF' });
    expect((await suggestClientsForDomains(['acf.com'])).size).toBe(0);
  });

  it('never suggests for an archived client', async () => {
    const c = await createClient(admin, { name: 'Gonebot' });
    await query('UPDATE clients SET archived = true WHERE id = $1', [c.id]);
    expect((await suggestClientsForDomains(['gonebot.com'])).size).toBe(0);
  });
});
