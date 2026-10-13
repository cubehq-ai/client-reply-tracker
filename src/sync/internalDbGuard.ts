import pg from 'pg';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

/**
 * Runtime guarantees that the internal tool's database is reachable for reads
 * only. These run before any query and throw rather than degrade, because the
 * failure they prevent — writing to someone else's production database — is
 * not recoverable by retrying.
 *
 * The real guarantee is the grant on the Postgres role itself; this is the
 * check that the grant is actually what we were told it is.
 */

export class InternalDbWriteRisk extends Error {}

/** Normalises a connection string for comparison: host, port and database. */
function identity(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Refuses to proceed when the internal DB points at the same database as the
 * tracker's own. We write freely to ours; if they were the same, every write
 * we believe is local would land in theirs.
 */
export function assertDistinctFromTrackerDb(): void {
  if (!config.internalDb.url) return;
  const internal = identity(config.internalDb.url);
  const tracker = identity(config.databaseUrl);
  if (internal && tracker && internal === tracker) {
    throw new InternalDbWriteRisk(
      'INTERNAL_DB_URL points at the same database as DATABASE_URL. ' +
        'The tracker writes to DATABASE_URL, so this would write to the internal tool. Use a separate read-only login.',
    );
  }
}

export interface ReadOnlyCheck {
  ok: boolean;
  role: string;
  isSuperuser: boolean;
  sessionReadOnly: boolean;
  writableTables: string[];
  reason?: string;
}

/**
 * Verifies the credential genuinely cannot write: not a superuser, holds no
 * INSERT/UPDATE/DELETE/TRUNCATE on any table, and cannot create objects.
 */
export async function checkInternalDbReadOnly(): Promise<ReadOnlyCheck> {
  if (!config.internalDb.url) {
    return { ok: false, role: '', isSuperuser: false, sessionReadOnly: false, writableTables: [], reason: 'INTERNAL_DB_URL is not set' };
  }
  assertDistinctFromTrackerDb();

  const pool = new pg.Pool({
    connectionString: config.internalDb.url,
    max: 1,
    ssl: /neon\.tech|sslmode=require|amazonaws/.test(config.internalDb.url) ? { rejectUnauthorized: false } : undefined,
  });

  try {
    const client = await pool.connect();
    try {
      await client.query('BEGIN TRANSACTION READ ONLY');

      const who = await client.query<{ role: string; is_superuser: boolean; read_only: string }>(
        `SELECT current_user AS role,
                (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS is_superuser,
                current_setting('transaction_read_only') AS read_only`,
      );
      const row = who.rows[0]!;

      // Any table this role could modify is a hole in the guarantee.
      const writable = await client.query<{ full_name: string }>(
        `SELECT quote_ident(table_schema) || '.' || quote_ident(table_name) AS full_name
           FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog','information_schema')
            AND table_type = 'BASE TABLE'
            AND (
              has_table_privilege(table_schema || '.' || table_name, 'INSERT')
              OR has_table_privilege(table_schema || '.' || table_name, 'UPDATE')
              OR has_table_privilege(table_schema || '.' || table_name, 'DELETE')
              OR has_table_privilege(table_schema || '.' || table_name, 'TRUNCATE')
            )
          ORDER BY 1
          LIMIT 50`,
      );

      await client.query('COMMIT');

      const writableTables = writable.rows.map((r) => r.full_name);
      const isSuperuser = Boolean(row.is_superuser);
      const ok = !isSuperuser && writableTables.length === 0;

      return {
        ok,
        role: row.role,
        isSuperuser,
        sessionReadOnly: row.read_only === 'on',
        writableTables,
        reason: ok
          ? undefined
          : isSuperuser
            ? `role "${row.role}" is a superuser, so no grant can restrain it`
            : `role "${row.role}" can modify ${writableTables.length} table(s), e.g. ${writableTables.slice(0, 3).join(', ')}`,
      };
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

/**
 * Called before the internal DB is used for real. Throws unless the credential
 * is provably read-only, unless the operator has explicitly accepted the risk
 * via INTERNAL_DB_ALLOW_WRITABLE_CREDENTIAL=true.
 */
export async function assertInternalDbReadOnly(): Promise<ReadOnlyCheck> {
  const check = await checkInternalDbReadOnly();
  if (check.ok) return check;

  if (process.env.INTERNAL_DB_ALLOW_WRITABLE_CREDENTIAL === 'true') {
    logger.warn({ check }, 'internal DB credential is NOT read-only, continuing because INTERNAL_DB_ALLOW_WRITABLE_CREDENTIAL=true');
    return check;
  }
  throw new InternalDbWriteRisk(
    `Refusing to use INTERNAL_DB_URL: ${check.reason}. ` +
      'Grant a SELECT-only role (see docs/STATUS.md), or set INTERNAL_DB_ALLOW_WRITABLE_CREDENTIAL=true to accept the risk.',
  );
}
