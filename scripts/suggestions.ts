import { closePool } from '../src/db/pool.js';
import { unmatchedSenders } from '../src/api/settings.js';
const rows = await unmatchedSenders();
const withSug = rows.filter((r: any) => r.suggestion);
console.log(`${rows.length} unmatched senders, ${withSug.length} with a suggested client\n`);
for (const r of withSug.slice(0, 15)) {
  console.log(`  ${r.from_domain.padEnd(32)} -> ${r.suggestion.name}  (${r.items} item(s))`);
}
await closePool();
