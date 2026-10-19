import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import { dismissNewPerson, listNewPeople, NEW_PERSON_WINDOW_DAYS } from '../src/sync/internalSync.js';
import { addMailbox } from '../src/api/settings.js';
import type { SessionUser } from '../src/api/auth.js';
import { freshHarness, setupSchema, teardown } from './helpers.js';

const admin: SessionUser = { id: 1, email: 'dev@cubehq.ai', name: 'Dev', role: 'admin', canSendAsShared: true };

async function seen(email: string, daysAgo: number, role = 'SEO'): Promise<void> {
  await query(
    `INSERT INTO internal_people_seen (email, name, role, first_seen_at, last_seen_at)
     VALUES ($1, $2, $3, now() - ($4 || ' days')::interval, now())
     ON CONFLICT (email) DO UPDATE SET first_seen_at = EXCLUDED.first_seen_at`,
    [email, email.split('@')[0], role, String(daysAgo)],
  );
}

beforeAll(async () => { await setupSchema(); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await freshHarness();
  await query('TRUNCATE internal_people_seen');
});

describe('newly seen people', () => {
  it('lists someone who appeared inside the window', async () => {
    await seen('joiner@cubehq.ai', 1);
    const people = await listNewPeople();
    expect(people.map((p) => p.email)).toContain('joiner@cubehq.ai');
    expect(people[0]).toMatchObject({ role: 'SEO' });
  });

  it('drops someone once the window has passed', async () => {
    await seen('old@cubehq.ai', NEW_PERSON_WINDOW_DAYS + 1);
    expect((await listNewPeople()).map((p) => p.email)).not.toContain('old@cubehq.ai');
  });

  it('stops listing someone once their mailbox is watched', async () => {
    await seen('added@cubehq.ai', 2);
    expect((await listNewPeople()).map((p) => p.email)).toContain('added@cubehq.ai');
    await addMailbox(admin, { email: 'added@cubehq.ai', team: 'SEO' });
    expect((await listNewPeople()).map((p) => p.email)).not.toContain('added@cubehq.ai');
  });

  it('stops listing someone who was dismissed', async () => {
    await seen('nope@cubehq.ai', 2);
    await dismissNewPerson('nope@cubehq.ai');
    expect((await listNewPeople()).map((p) => p.email)).not.toContain('nope@cubehq.ai');
  });

  it('shows the most recent first', async () => {
    await seen('older@cubehq.ai', 10);
    await seen('newer@cubehq.ai', 1);
    const emails = (await listNewPeople()).map((p) => p.email);
    expect(emails.indexOf('newer@cubehq.ai')).toBeLessThan(emails.indexOf('older@cubehq.ai'));
  });

  it('is empty when nobody is new', async () => {
    expect(await listNewPeople()).toEqual([]);
  });
});
