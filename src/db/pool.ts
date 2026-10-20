import pg from 'pg';
import { Resolver } from 'node:dns/promises';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

const needsSsl = /neon\.tech|sslmode=require/.test(config.databaseUrl);

// Strip sslmode/channel_binding from the URL and configure TLS on the driver
// instead; node-postgres warns that its sslmode handling is changing.
function cleanUrl(url: string): string {
  try {
    const u = new URL(url);
    u.searchParams.delete('sslmode');
    u.searchParams.delete('channel_binding');
    return u.toString();
  } catch {
    return url;
  }
}

function dbHost(): string {
  try {
    return new URL(config.databaseUrl).hostname;
  } catch {
    return '';
  }
}

/**
 * Public resolvers to fall back on when the machine's own cannot answer.
 *
 * Some networks hand out a resolver that refuses hostnames it does not like:
 * one here returned REFUSED for the database host while answering everything
 * else, which took the API and worker down repeatedly. pg gives no way to
 * pass a custom lookup, so when the system resolver fails we resolve the host
 * ourselves and pin the pool to the address.
 */
const FALLBACK_DNS = (process.env.DNS_FALLBACK_SERVERS ?? '1.1.1.1,8.8.8.8')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function resolveViaFallback(host: string): Promise<string | null> {
  if (!host || FALLBACK_DNS.length === 0) return null;
  const resolver = new Resolver();
  resolver.setServers(FALLBACK_DNS);
  try {
    const [address] = await resolver.resolve4(host);
    return address ?? null;
  } catch (err) {
    logger.warn({ host, err }, 'fallback DNS could not resolve the database host either');
    return null;
  }
}

function createPool(address?: string): pg.Pool {
  const host = dbHost();
  const url = new URL(cleanUrl(config.databaseUrl));
  if (address) url.hostname = address;

  const next = new pg.Pool({
    connectionString: url.toString(),
    // servername keeps SNI pointed at the real host, which Neon routes on and
    // TLS validates against, even when connecting straight to an address.
    ssl: needsSsl ? { rejectUnauthorized: true, servername: host } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
  });

  // An idle client dropped by the network emits here. Unhandled, it takes the
  // whole process down; the pool discards the client either way.
  next.on('error', (err) => logger.warn({ err }, 'idle database client errored; it will be replaced'));
  return next;
}

let activePool = createPool();
let pinnedAddress: string | null = null;

export function getPool(): pg.Pool {
  return activePool;
}

/** Kept for callers that held the pool directly. */
export const pool = new Proxy({} as pg.Pool, {
  get: (_t, prop) => Reflect.get(activePool, prop, activePool),
});

const TRANSIENT = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
]);

export function isTransient(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code != null && TRANSIENT.has(code);
}

function isDnsFailure(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'ENOTFOUND' || code === 'EAI_AGAIN';
}

/**
 * Retries a database call through a transient network failure.
 *
 * A blip in name resolution used to surface as a 500 on every route and kill
 * the worker outright. Three tries over roughly a second and a half cover a
 * dropped connection; a DNS failure additionally re-resolves the host and
 * rebuilds the pool against the address.
 */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err) || attempt === attempts) throw err;

      if (isDnsFailure(err) && pinnedAddress == null) {
        const address = await resolveViaFallback(dbHost());
        if (address) {
          pinnedAddress = address;
          logger.warn({ host: dbHost() }, 'system resolver failed; pinning the pool to an address from fallback DNS');
          const stale = activePool;
          activePool = createPool(address);
          void stale.end().catch(() => {});
        }
      }

      await new Promise((r) => setTimeout(r, 250 * attempt ** 2));
    }
  }
  throw lastErr;
}

export type Row = Record<string, any>;

export async function query<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T[]> {
  const res = await withRetry(() => activePool.query(text, params as any[]));
  return res.rows as T[];
}

export async function one<T extends Row = Row>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Runs fn inside a transaction, rolling back on any throw.
 *
 * Only getting the connection is retried. Once statements have run, replaying
 * fn could repeat a write that already landed.
 */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await withRetry(() => activePool.connect());
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await activePool.end();
}
