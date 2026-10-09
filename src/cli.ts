import { closePool, query } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { isEntrypoint } from './lib/main.js';
import { logger } from './lib/logger.js';
import { discoverMailboxes } from './sync/discovery.js';
import { syncAllMailboxes } from './sync/mailboxSync.js';
import { syncClients } from './sync/clients.js';
import { seedReferenceData } from './sync/seed.js';
import { reconcileOpenItems } from './sync/reconcile.js';
import { renewWatches } from './sync/watch.js';
import { purgeOldBodies } from './sync/retention.js';

const commands: Record<string, () => Promise<unknown>> = {
  migrate: () => migrate(),
  seed: async () => {
    await seedReferenceData();
    await discoverMailboxes();
    return syncClients();
  },
  discover: () => discoverMailboxes(),
  'sync-clients': () => syncClients(),
  sync: () => syncAllMailboxes(),
  reconcile: () => reconcileOpenItems(),
  'renew-watches': () => renewWatches(),
  'purge-bodies': () => purgeOldBodies(),
  bootstrap: async () => {
    await migrate();
    await seedReferenceData();
    await discoverMailboxes();
    await syncClients();
    return syncAllMailboxes();
  },
  status: async () => {
    const [states, mailboxes, clients] = await Promise.all([
      query('SELECT state, count(*)::int AS n FROM items GROUP BY state ORDER BY n DESC'),
      query('SELECT email, status, last_synced_at IS NOT NULL AS synced FROM mailboxes ORDER BY email'),
      query('SELECT c.name, count(i.id)::int AS open FROM clients c LEFT JOIN items i ON i.client_id = c.id AND i.state = \'needs_reply\' GROUP BY c.name ORDER BY open DESC'),
    ]);
    return { states, mailboxes, clients };
  },
};

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? 'status';
  const fn = commands[cmd];
  if (!fn) {
    console.error(`unknown command: ${cmd}\navailable: ${Object.keys(commands).join(', ')}`);
    process.exitCode = 1;
    return;
  }
  const result = await fn();
  console.log(JSON.stringify(result, null, 2));
}

if (isEntrypoint(import.meta.url)) {
  main()
    .catch((err) => {
      logger.error({ err }, 'cli failed');
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
