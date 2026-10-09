import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../src/db/pool.js';
import {
  acquireLock, handledElsewhere, ignoreItem, linkToClient, markNeedsReply,
  reassignItem, snoozeItem, undoIgnore,
} from '../src/api/actions.js';
import type { SessionUser } from '../src/api/auth.js';
import { syncAllMailboxes } from '../src/sync/mailboxSync.js';
import { freshHarness, itemBySubject, setupSchema, teardown } from './helpers.js';

const admin: SessionUser = { id: 0, email: 'dev@cubehq.ai', name: 'Dev', role: 'admin', canSendAsShared: true };
const member: SessionUser = { id: 0, email: 'priya@cubehq.ai', name: 'Priya', role: 'member', canSendAsShared: false };

beforeAll(async () => { await setupSchema(); });
afterAll(async () => { await teardown(); });
beforeEach(async () => {
  await freshHarness();
  await syncAllMailboxes();
  // Session ids must match the real user rows.
  for (const u of [admin, member]) {
    const row = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [u.email]);
    u.id = Number(row[0]!.id);
  }
});

describe('ignore', () => {
  it('ignores a single message and leaves it reopenable', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    const res = await ignoreItem(admin, Number(item.id), 'not_needed', 'message');
    expect(res.state).toBe('ignored');
    const after = await itemBySubject('Q3 invoice discrepancy');
    expect(after.muted).toBe(false);
  });

  it('mutes the thread so later mail cannot reopen it', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await ignoreItem(admin, Number(item.id), 'not_needed', 'thread');
    expect((await itemBySubject('Q3 invoice discrepancy')).muted).toBe(true);
  });

  it('creates a block rule for the sender', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    const res = await ignoreItem(admin, Number(item.id), 'spam', 'sender');
    expect(res.ruleCreated).toBe('block_sender:ops@acme.com');
    const rules = await query("SELECT * FROM rules WHERE type = 'block_sender'");
    expect(rules).toHaveLength(1);
  });

  it('refuses to block a client domain unless you are an admin', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await expect(ignoreItem(member, Number(item.id), 'spam', 'domain')).rejects.toThrow(/requires role/);
  });

  it('lets an admin block a client domain', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    const res = await ignoreItem(admin, Number(item.id), 'spam', 'domain');
    expect(res.ruleCreated).toBe('block_domain:acme.com');
  });

  it('undoes an ignore', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await ignoreItem(admin, Number(item.id), 'not_needed', 'message');
    const res = await undoIgnore(admin, Number(item.id));
    expect(res.state).toBe('needs_reply');
  });

  it('records every ignore in the audit log', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await ignoreItem(admin, Number(item.id), 'not_needed', 'message');
    const rows = await query("SELECT * FROM audit_log WHERE action = 'ignore'");
    expect(rows).toHaveLength(1);
  });
});

describe('snooze', () => {
  it('snoozes until a future time', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    const until = new Date(Date.now() + 3_600_000);
    const res = await snoozeItem(admin, Number(item.id), until);
    expect(res.state).toBe('snoozed');
  });

  it('rejects a time in the past', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await expect(snoozeItem(admin, Number(item.id), new Date(Date.now() - 1000))).rejects.toThrow(/future/);
  });
});

describe('other actions', () => {
  it('marks handled elsewhere', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    expect((await handledElsewhere(admin, Number(item.id), 'called them')).state).toBe('handled_elsewhere');
  });

  it('reassigns and adds the new owner as a watcher', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await reassignItem(admin, Number(item.id), 'rahul@cubehq.ai');
    const after = await itemBySubject('Q3 invoice discrepancy');
    expect(after.watchers).toContain('rahul@cubehq.ai');
  });

  it('rejects reassigning to an unknown user', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    await expect(reassignItem(admin, Number(item.id), 'nobody@cubehq.ai')).rejects.toThrow(/no such user/);
  });

  it('promotes an FYI and records the disagreement for training', async () => {
    const item = await itemBySubject('Shipping address update');
    expect(item.state).toBe('fyi');
    await markNeedsReply(admin, Number(item.id));
    expect((await itemBySubject('Shipping address update')).state).toBe('needs_reply');
    const feedback = await query('SELECT * FROM classifier_feedback');
    expect(feedback).toHaveLength(1);
  });
});

describe('link to client', () => {
  it('links a personal address and rematches', async () => {
    const item = await itemBySubject('Question about your pricing');
    expect(item.client_id).toBeNull();
    const client = await query<{ id: string }>("SELECT id FROM clients WHERE name = 'Zenith Retail'");
    const res = await linkToClient(admin, Number(item.id), Number(client[0]!.id), 'email');
    expect(res.linked).toBe('random.person@gmail.com');
    expect((await itemBySubject('Question about your pricing')).client_id).not.toBeNull();
  });

  it('refuses to map a free email domain to a client', async () => {
    const item = await itemBySubject('Question about your pricing');
    const client = await query<{ id: string }>("SELECT id FROM clients WHERE name = 'Zenith Retail'");
    await expect(linkToClient(admin, Number(item.id), Number(client[0]!.id), 'domain'))
      .rejects.toThrow(/free email provider/);
  });
});

describe('composer lock', () => {
  it('reports when someone else holds the lock', async () => {
    const item = await itemBySubject('Q3 invoice discrepancy');
    expect(await acquireLock(admin, Number(item.id))).toMatchObject({ mine: true });
    expect(await acquireLock(member, Number(item.id))).toMatchObject({ mine: false, lockedBy: 'dev@cubehq.ai' });
  });
});
