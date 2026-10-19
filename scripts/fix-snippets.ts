/** Decodes HTML entities in snippets stored before normalize() did it. */
import { closePool, query } from '../src/db/pool.js';
import { decodeEntities } from '../src/lib/html.js';

const rows = await query<{ id: string; snippet: string }>(
  "SELECT id, snippet FROM messages WHERE snippet LIKE '%&%;%'",
);
let fixed = 0;
for (const row of rows) {
  const decoded = decodeEntities(row.snippet);
  if (decoded === row.snippet) continue;
  await query('UPDATE messages SET snippet = $2 WHERE id = $1', [row.id, decoded]);
  fixed += 1;
}
console.log(`scanned ${rows.length}, rewrote ${fixed}`);
await closePool();
