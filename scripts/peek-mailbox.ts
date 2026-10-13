/**
 * Lists recent subjects for one mailbox, straight from Gmail.
 * Read-only: nothing is written to the database.
 */
import { RealGmailClient } from '../src/gmail/real.js';
import { closePool, query } from '../src/db/pool.js';

const mailbox = (process.argv[2] ?? '').toLowerCase();
const limit = Number(process.argv[3] ?? 10);
if (!mailbox) {
  console.error('usage: tsx scripts/peek-mailbox.ts <email> [count]');
  process.exit(1);
}

// Honour the exclusion list even for an ad-hoc look (SPEC 11).
const excluded = await query<{ value: string }>(
  "SELECT value FROM exclusions WHERE kind = 'mailbox' AND lower(value) = $1",
  [mailbox],
);
if (excluded.length > 0) {
  console.error(`${mailbox} is on the exclusion list and must not be read.`);
  await closePool();
  process.exit(1);
}

const gmail = new RealGmailClient();
const ids = await gmail.listMessageIds(mailbox, '-in:chats -in:spam -in:trash', limit);

console.log(`\n${mailbox} — ${ids.length} most recent\n`);
let n = 0;
for (const { id } of ids.slice(0, limit)) {
  const m = await gmail.getMessage(mailbox, id);
  if (!m) continue;
  n += 1;
  const when = new Date(m.internalDateMs).toLocaleString();
  const from = (m.headers.from ?? '').replace(/"/g, '').slice(0, 42);
  const subject = m.headers.subject ?? '(no subject)';
  const labels = m.labelIds.filter((l) => ['INBOX', 'SENT', 'UNREAD', 'DRAFT'].includes(l)).join(',');
  console.log(`${String(n).padStart(2)}. ${subject}`);
  console.log(`    from ${from}  ·  ${when}  ·  ${labels}`);
}
await closePool();
