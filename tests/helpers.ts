import { closePool, query } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { FakeDirectoryClient, FakeGmailClient } from '../src/gmail/fake.js';
import { setClients } from '../src/gmail/index.js';
import { setLlmClient } from '../src/llm/index.js';
import { FakeLlmClient } from '../src/llm/fake.js';
import { clearMailboxCache } from '../src/pipeline/ingest.js';
import { discoverMailboxes } from '../src/sync/discovery.js';
import { syncClients } from '../src/sync/clients.js';
import { seedReferenceData } from '../src/sync/seed.js';

export interface Harness {
  gmail: FakeGmailClient;
  llm: FakeLlmClient;
}

/** Fresh fakes + empty data tables. No network calls anywhere. */
export async function freshHarness(): Promise<Harness> {
  const gmail = new FakeGmailClient();
  const llm = new FakeLlmClient();
  setClients(gmail, new FakeDirectoryClient());
  setLlmClient(llm);

  await query(`TRUNCATE items, item_events, item_locks, messages, message_copies, conversations,
    conversation_keys, classifications, classifier_feedback, audit_log, attachments RESTART IDENTITY CASCADE`);
  await query('UPDATE mailboxes SET last_history_id = NULL, backfilled_at = NULL, last_synced_at = NULL');
  clearMailboxCache();
  return { gmail, llm };
}

export async function setupSchema(): Promise<void> {
  await migrate();
  setClients(new FakeGmailClient(), new FakeDirectoryClient());
  await query('TRUNCATE clients, client_domains, client_contacts, rules, exclusions RESTART IDENTITY CASCADE');
  await seedReferenceData();
  await discoverMailboxes();
  await syncClients();
}

export async function teardown(): Promise<void> {
  setClients(null, null);
  setLlmClient(null);
  await closePool();
}

/** state keyed by conversation subject, for readable assertions. */
export async function statesBySubject(): Promise<Record<string, string>> {
  const rows = await query<{ subject: string; state: string }>(
    'SELECT c.subject, i.state FROM items i JOIN conversations c ON c.id = i.conversation_id',
  );
  return Object.fromEntries(rows.map((r) => [r.subject, r.state]));
}

export async function itemBySubject(subject: string): Promise<any> {
  const rows = await query(
    `SELECT i.*, c.global_key FROM items i JOIN conversations c ON c.id = i.conversation_id WHERE c.subject = $1`,
    [subject],
  );
  return rows[0] ?? null;
}
