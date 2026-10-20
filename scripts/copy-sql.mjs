/**
 * Copies the .sql migrations into the compiled output.
 *
 * tsc emits JavaScript and nothing else, so dist/src/db/migrations did not
 * exist and `node dist/src/db/migrate.js` died with ENOENT on every boot --
 * which on Railway meant the web service never started, because migrations
 * run before the server.
 */
import { cp, mkdir } from 'node:fs/promises';

const from = new URL('../src/db/migrations/', import.meta.url);
const to = new URL('../dist/src/db/migrations/', import.meta.url);

await mkdir(to, { recursive: true });
await cp(from, to, { recursive: true });
console.log('copied migrations into dist');
