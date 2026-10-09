import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closePool, pool, query } from './pool.js';
import { logger } from '../lib/logger.js';
import { isEntrypoint } from '../lib/main.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

export async function migrate(): Promise<string[]> {
  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const applied = new Set((await query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(migrationsDir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
      logger.info({ file }, 'migration applied');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ file, err }, 'migration failed');
      throw err;
    } finally {
      client.release();
    }
  }
  return ran;
}

if (isEntrypoint(import.meta.url)) {
  migrate()
    .then((ran) => {
      logger.info({ count: ran.length }, ran.length ? 'migrations complete' : 'already up to date');
    })
    .catch((err) => {
      logger.error({ err }, 'migrate failed');
      process.exitCode = 1;
    })
    .finally(() => closePool());
}
