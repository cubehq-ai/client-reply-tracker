import { withInternalDb } from '../src/sync/internalMongo.js';

/** Field shapes only, with values redacted unless they are needed for mapping. */
await withInternalDb(async (db) => {
  for (const name of ['clients', 'team_members']) {
    const col = db.collection(name);
    const docs = await col.find({}, 40);
    const keys = new Set<string>();
    for (const d of docs) for (const k of Object.keys(d)) keys.add(k);
    console.log(`\n=== ${name} (${await col.countDocuments({})} docs)`);
    console.log('keys:', [...keys].sort().join(', '));

    // Which keys could carry a domain or an address?
    const interesting = [...keys].filter((k) => /domain|website|url|site|email|name|slug|team|role|active|churn/i.test(k));
    const first = docs[0] as Record<string, any> | undefined;
    if (first) {
      console.log('sample (selected keys):');
      for (const k of interesting) {
        const v = first[k];
        const shown = typeof v === 'string' && v.includes('@') ? `***@${v.split('@')[1]}` : v;
        console.log(`  ${k}: ${JSON.stringify(shown)?.slice(0, 90)}`);
      }
    }
  }
});
