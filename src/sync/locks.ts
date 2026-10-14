import { query } from '../db/pool.js';

/** Expired composer locks (SPEC 9). */
export async function clearExpiredLocks(): Promise<number> {
  const rows = await query<{ item_id: string }>('DELETE FROM item_locks WHERE expires_at < now() RETURNING item_id');
  return rows.length;
}
