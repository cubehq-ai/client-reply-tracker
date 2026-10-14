import { withInternalDb } from '../src/sync/internalMongo.js';

/** Which fields anywhere in a client document contain a hostname or URL? */
const HOST = /(?:https?:\/\/|sc-domain:|www\.)?([a-z0-9][a-z0-9-]*\.)+[a-z]{2,}/i;

await withInternalDb(async (db) => {
  const docs = await db.collection('clients').find<any>({}, 500);
  const hits = new Map<string, { n: number; sample: string }>();

  const walk = (value: unknown, path: string) => {
    if (typeof value === 'string') {
      if (HOST.test(value) && !value.includes('@')) {
        const e = hits.get(path) ?? { n: 0, sample: value.slice(0, 60) };
        e.n += 1;
        hits.set(path, e);
      }
      return;
    }
    if (Array.isArray(value)) { value.forEach((v) => walk(v, `${path}[]`)); return; }
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) walk(v, path ? `${path}.${k}` : k);
    }
  };

  for (const d of docs) walk(d, '');
  console.log(`scanned ${docs.length} clients\n`);
  for (const [path, info] of [...hits.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 20)) {
    console.log(`${String(info.n).padStart(4)}  ${path.padEnd(38)} e.g. ${info.sample}`);
  }
});
