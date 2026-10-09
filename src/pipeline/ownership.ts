import { query } from '../db/pool.js';

export interface OwnershipInput {
  to: string[];
  cc: string[];
  /** Mailboxes that received a copy of this message. */
  recipientMailboxes: string[];
  isInternal: (email: string) => boolean;
  isSharedInbox: (email: string) => boolean;
  /** Account manager for the matched client, if any. */
  accountManagerEmail: string | null;
}

export interface Ownership {
  ownerEmail: string | null;
  watchers: string[];
}

/**
 * Ownership (SPEC 4 step 6): first internal address in To, else first in Cc.
 * When the mail only went to a shared inbox, the client's account manager owns
 * it instead. Every internal recipient is a watcher.
 */
export function resolveOwnership(input: OwnershipInput): Ownership {
  const internalTo = input.to.filter(input.isInternal);
  const internalCc = input.cc.filter(input.isInternal);
  const watchers = [...new Set([...internalTo, ...internalCc, ...input.recipientMailboxes.filter(input.isInternal)])];

  const personalTo = internalTo.find((e) => !input.isSharedInbox(e));
  const personalCc = internalCc.find((e) => !input.isSharedInbox(e));

  // A named person beats a shared inbox; a shared inbox defers to the AM.
  let owner = personalTo ?? personalCc ?? null;
  if (!owner) {
    const sharedOnly = internalTo.length > 0 || internalCc.length > 0;
    if (sharedOnly && input.accountManagerEmail) owner = input.accountManagerEmail;
    else owner = internalTo[0] ?? internalCc[0] ?? input.accountManagerEmail ?? null;
  }

  return { ownerEmail: owner, watchers };
}

export async function userIdForEmail(email: string | null): Promise<number | null> {
  if (!email) return null;
  const rows = await query<{ id: string }>('SELECT id FROM users WHERE email = $1', [email]);
  return rows[0] ? Number(rows[0].id) : null;
}
