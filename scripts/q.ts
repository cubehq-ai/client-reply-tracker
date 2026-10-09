import { closePool, query } from '../src/db/pool.js';
const sql = process.argv.slice(2).join(' ');
console.table(await query(sql));
await closePool();
