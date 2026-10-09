import { query, closePool } from '../src/db/pool.js';
const t = await query("select table_name from information_schema.tables where table_schema='public' order by 1");
console.log('tables (' + t.length + '):', t.map((r: any) => r.table_name).join(', '));
await closePool();
