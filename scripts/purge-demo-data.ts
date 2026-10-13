/**
 * Removes every trace of the demo fixtures from a live database: ingested
 * mail, and the invented users, mailboxes and clients that came with them.
 *
 * Real rows are preserved: the signed-in account, the roster mailboxes and
 * their teams, and anything a human added through Settings.
 */
import { closePool, query } from '../src/db/pool.js';
import { FIXTURE_CLIENTS, FIXTURE_USERS } from '../src/gmail/fixtures.js';
import { config } from '../src/lib/config.js';

const keep = new Set([config.server.devUserEmail.toLowerCase()]);
const fixtureEmails = FIXTURE_USERS.map((u) => u.email.toLowerCase()).filter((e) => !keep.has(e));
const fixtureClientIds = FIXTURE_CLIENTS.map((c) => c.externalId);

// All ingested mail goes: none of it came from a real mailbox.
await query(`TRUNCATE items, item_events, item_locks, messages, message_copies, conversations,
  conversation_keys, classifications, classifier_feedback, attachments RESTART IDENTITY CASCADE`);

const clients = await query(
  `DELETE FROM clients WHERE external_id = ANY($1::text[]) RETURNING name`,
  [fixtureClientIds],
);

const mailboxes = await query(
  `DELETE FROM mailboxes WHERE email = ANY($1::citext[]) RETURNING email`,
  [fixtureEmails],
);

const users = await query(
  `DELETE FROM users WHERE email = ANY($1::citext[]) RETURNING email`,
  [fixtureEmails],
);

await query(`UPDATE mailboxes SET last_history_id = NULL, backfilled_at = NULL, last_synced_at = NULL`);
await query(`DELETE FROM settings WHERE key = 'local_classifier_v1'`);

console.log(JSON.stringify({
  mailRemoved: 'all ingested messages, conversations and items',
  clientsRemoved: clients.map((c: any) => c.name),
  mailboxesRemoved: mailboxes.map((m: any) => m.email),
  usersRemoved: users.map((u: any) => u.email),
  kept: [...keep],
}, null, 2));

await closePool();
