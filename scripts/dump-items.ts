import { closePool, query } from '../src/db/pool.js';
const rows = await query(`
  SELECT i.state, COALESCE(cl.name,'(unmatched)') AS client, c.subject,
         i.filter_reason, i.intent, i.priority, i.reopen_count,
         u.email AS owner, i.needs_reply_confidence AS conf
    FROM items i
    JOIN conversations c ON c.id = i.conversation_id
    LEFT JOIN clients cl ON cl.id = i.client_id
    LEFT JOIN users u ON u.id = i.owner_user_id
   ORDER BY i.state, c.subject`);
for (const r of rows as any[]) {
  console.log(
    `${(r.state as string).padEnd(18)} ${(r.client as string).padEnd(20)} ${String(r.subject).slice(0, 44).padEnd(45)} ` +
    `${r.filter_reason ?? r.intent ?? '-'}  owner=${r.owner ?? '-'} reopen=${r.reopen_count}`,
  );
}
console.log(`\ntotal items: ${rows.length}`);
await closePool();
