import { closePool } from '../src/db/pool.js';
import { applyDomainSuggestions } from '../src/api/settings.js';
const res = await applyDomainSuggestions({ id: 0, email: 'dev@cubehq.ai', name: 'Dev', role: 'admin', canSendAsShared: true });
console.log(`linked ${res.linked.length}, skipped ${res.skipped.length}`);
for (const l of res.linked) console.log(`  ${l.domain} -> ${l.client}`);
await closePool();
