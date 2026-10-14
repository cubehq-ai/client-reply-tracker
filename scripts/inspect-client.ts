import { withInternalDb } from '../src/sync/internalMongo.js';
const name = process.argv[2] ?? 'Norbot';
await withInternalDb(async (db) => {
  const docs = await db.collection('clients').find<any>({}, 500);
  const doc = docs.find((d) => String(d.name ?? '').toLowerCase().includes(name.toLowerCase()));
  if (!doc) { console.log('not found'); return; }
  for (const [k, v] of Object.entries(doc)) {
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (k === 'portal_password') continue;
    console.log(`${k}: ${s.slice(0, 220)}`);
  }
});
