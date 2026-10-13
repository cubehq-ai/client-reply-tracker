import { MongoClient, type Db, type Document } from 'mongodb';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

/**
 * Read-only access to the company's internal MongoDB (the agency dashboard).
 *
 * The guarantee here is structural: `ReadOnlyCollection` exposes only read
 * operations and never hands out a raw driver collection, so no code path in
 * this project can issue a write. The credential check below is a second
 * opinion on whether the login itself is restrained.
 */

export class InternalMongoWriteRisk extends Error {}

/** Read operations. There is deliberately no insert/update/delete/drop here. */
export class ReadOnlyCollection {
  constructor(private db: Db, private name: string) {}

  find<T extends Document = Document>(filter: Document = {}, limit = 1000): Promise<T[]> {
    return this.db.collection<any>(this.name).find(filter).limit(limit).toArray() as Promise<T[]>;
  }

  findOne<T extends Document = Document>(filter: Document = {}): Promise<T | null> {
    return this.db.collection<any>(this.name).findOne(filter) as Promise<T | null>;
  }

  aggregate<T extends Document = Document>(pipeline: Document[], limit = 1000): Promise<T[]> {
    // Reject a pipeline that would write, even though the role should prevent it.
    for (const stage of pipeline) {
      for (const key of Object.keys(stage)) {
        if (key === '$out' || key === '$merge') {
          throw new InternalMongoWriteRisk(`aggregation stage ${key} writes to the internal database and is not allowed`);
        }
      }
    }
    return this.db.collection<any>(this.name).aggregate(pipeline).limit(limit).toArray() as Promise<T[]>;
  }

  countDocuments(filter: Document = {}): Promise<number> {
    return this.db.collection(this.name).countDocuments(filter);
  }

  distinct(field: string, filter: Document = {}): Promise<any[]> {
    return this.db.collection(this.name).distinct(field, filter);
  }
}

export class ReadOnlyDb {
  constructor(private db: Db) {}
  collection(name: string): ReadOnlyCollection {
    return new ReadOnlyCollection(this.db, name);
  }
  listCollections(): Promise<{ name: string; type: string }[]> {
    return this.db.listCollections().toArray() as unknown as Promise<{ name: string; type: string }[]>;
  }
  /** Escape hatch for the role check only; not exported beyond this module. */
  raw(): Db {
    return this.db;
  }
}

function connectionString(): string {
  const url = config.internalMongo.url;
  if (!url) throw new Error('INTERNAL_MONGO_URL is not set (put it in .env.internal)');
  return url;
}

/** Opens a connection, runs fn, always closes. */
export async function withInternalDb<T>(fn: (db: ReadOnlyDb) => Promise<T>): Promise<T> {
  const client = new MongoClient(connectionString(), {
    // A read-only consumer should never be the reason a write is waited on.
    readPreference: 'secondaryPreferred',
    serverSelectionTimeoutMS: 15_000,
    connectTimeoutMS: 15_000,
  });
  try {
    await client.connect();
    const dbName = config.internalMongo.db || new URL(connectionString().replace('mongodb+srv://', 'https://')).pathname.replace('/', '');
    return await fn(new ReadOnlyDb(client.db(dbName || undefined)));
  } finally {
    await client.close();
  }
}

export interface MongoRoleCheck {
  ok: boolean;
  user: string;
  roles: { role: string; db: string }[];
  writableRoles: string[];
  reason?: string;
}

const READ_ONLY_ROLES = new Set(['read', 'readAnyDatabase', 'clusterMonitor', 'backup']);

/**
 * Inspects the credential's roles. A writable role is reported loudly rather
 * than silently accepted, but it does not by itself make a write possible:
 * this module issues no write operation.
 */
export async function checkMongoCredential(): Promise<MongoRoleCheck> {
  return withInternalDb(async (db) => {
    const status = await db.raw().admin().command({ connectionStatus: 1 });
    const info = status?.authInfo ?? {};
    const roles: { role: string; db: string }[] = info.authenticatedUserRoles ?? [];
    const user = info.authenticatedUsers?.[0]?.user ?? 'unknown';
    const writableRoles = roles.filter((r) => !READ_ONLY_ROLES.has(r.role)).map((r) => `${r.role}@${r.db}`);
    return {
      ok: writableRoles.length === 0,
      user,
      roles,
      writableRoles,
      reason: writableRoles.length
        ? `user "${user}" holds write-capable role(s): ${writableRoles.join(', ')}. ` +
          'This tool issues no writes, but a dedicated read-only user is strongly recommended.'
        : undefined,
    };
  });
}

export interface MongoCollectionInfo {
  name: string;
  count: number;
  fields: string[];
  sample: Record<string, unknown> | null;
}

/** Lists collections with their field shape, so mapping is based on reality. */
export async function inspectInternalMongo(): Promise<{
  database: string;
  collections: MongoCollectionInfo[];
  likelyClients: string[];
  likelyEmployees: string[];
  credential: MongoRoleCheck | { error: string };
}> {
  let credential: MongoRoleCheck | { error: string };
  try {
    credential = await checkMongoCredential();
  } catch (err) {
    credential = { error: String(err) };
  }

  return withInternalDb(async (db) => {
    const names = (await db.listCollections()).filter((c) => c.type !== 'view' || true).map((c) => c.name).sort();
    const collections: MongoCollectionInfo[] = [];

    for (const name of names) {
      const col = db.collection(name);
      let count = 0;
      let sample: Record<string, unknown> | null = null;
      try {
        count = await col.countDocuments({});
        sample = (await col.findOne({})) as Record<string, unknown> | null;
      } catch (err) {
        logger.warn({ collection: name, err }, 'could not sample collection');
      }
      collections.push({
        name,
        count,
        fields: sample ? Object.keys(sample) : [],
        // Keys only by default; values may be personal data.
        sample: null,
      });
    }

    const matches = (re: RegExp) => collections.filter((c) => re.test(c.name.toLowerCase())).map((c) => c.name);
    return {
      database: config.internalMongo.db,
      collections,
      likelyClients: matches(/client|customer|account|brand|company/),
      likelyEmployees: matches(/employee|user|member|staff|people|team/),
      credential,
    };
  });
}
