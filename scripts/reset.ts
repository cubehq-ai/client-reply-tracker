import { closePool, query } from '../src/db/pool.js';
await query(`TRUNCATE items, item_events, item_locks, messages, message_copies, conversations,
  conversation_keys, classifications, classifier_feedback, audit_log, attachments RESTART IDENTITY CASCADE`);
await query(`UPDATE mailboxes SET last_history_id = NULL, backfilled_at = NULL, last_synced_at = NULL`);
console.log('data tables cleared (config, clients and mailboxes kept)');
await closePool();
