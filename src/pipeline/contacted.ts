import { query } from '../db/pool.js';
import type { PoolClient } from 'pg';
import { domainOf } from './normalize.js';

/**
 * Who we have written to before.
 *
 * This is the signal that separates a real correspondent we simply have not
 * linked to a client yet from cold outreach. It is built from our own Sent
 * mail, so it needs no model and costs one indexed lookup.
 *
 * Free providers are recorded per address: having emailed one person at
 * gmail.com says nothing about the next.
 */

export interface ContactIndex {
  domains: Set<string>;
  addresses: Set<string>;
  freeDomains: Set<string>;
  hasContacted(email: string): boolean;
}

export async function loadContactIndex(): Promise<ContactIndex> {
  const [domains, addresses, free] = await Promise.all([
    query<{ domain: string }>('SELECT domain FROM contacted_domains WHERE is_free_email_domain = false'),
    query<{ email: string }>('SELECT email FROM contacted_addresses'),
    query<{ domain: string }>('SELECT domain FROM free_email_domains'),
  ]);

  const domainSet = new Set(domains.map((d) => d.domain.toLowerCase()));
  const addressSet = new Set(addresses.map((a) => a.email.toLowerCase()));
  const freeSet = new Set(free.map((f) => f.domain.toLowerCase()));

  return {
    domains: domainSet,
    addresses: addressSet,
    freeDomains: freeSet,
    hasContacted(email: string): boolean {
      const e = email.toLowerCase();
      if (addressSet.has(e)) return true;
      const d = domainOf(e);
      // A free provider only ever matches the exact address.
      if (!d || freeSet.has(d)) return false;
      return domainSet.has(d);
    },
  };
}

/**
 * Records the external recipients of one of our sent messages. Called for
 * every outbound message during backfill and ongoing sync.
 */
export async function recordSentRecipients(
  c: PoolClient,
  recipients: string[],
  sentAt: Date,
  isInternal: (email: string) => boolean,
  freeDomains: Set<string>,
): Promise<void> {
  const external = [...new Set(recipients.map((e) => e.toLowerCase()).filter((e) => e && !isInternal(e)))];
  if (external.length === 0) return;

  const addressRows = external.filter((e) => freeDomains.has(domainOf(e)));
  const domainRows = [...new Set(external.map((e) => domainOf(e)).filter((d) => d && !freeDomains.has(d)))];

  if (domainRows.length > 0) {
    await c.query(
      `INSERT INTO contacted_domains (domain, first_sent_at, last_sent_at, is_free_email_domain)
       SELECT unnest($1::text[]), $2, $2, false
       ON CONFLICT (domain) DO UPDATE SET
         first_sent_at = LEAST(contacted_domains.first_sent_at, EXCLUDED.first_sent_at),
         last_sent_at  = GREATEST(contacted_domains.last_sent_at, EXCLUDED.last_sent_at),
         send_count    = contacted_domains.send_count + 1`,
      [domainRows, sentAt],
    );
  }

  if (addressRows.length > 0) {
    await c.query(
      `INSERT INTO contacted_addresses (email, first_sent_at, last_sent_at)
       SELECT unnest($1::text[]), $2, $2
       ON CONFLICT (email) DO UPDATE SET
         first_sent_at = LEAST(contacted_addresses.first_sent_at, EXCLUDED.first_sent_at),
         last_sent_at  = GREATEST(contacted_addresses.last_sent_at, EXCLUDED.last_sent_at),
         send_count    = contacted_addresses.send_count + 1`,
      [addressRows, sentAt],
    );
  }
}

/**
 * Rebuilds the index from stored outbound mail. Needed when the tables are
 * introduced after a backfill has already run, and safe to re-run.
 */
export async function backfillContacts(orgDomains: Set<string>): Promise<ContactStats> {
  const free = new Set(
    (await query<{ domain: string }>('SELECT domain FROM free_email_domains')).map((f) => f.domain.toLowerCase()),
  );

  await query(
    `INSERT INTO contacted_domains (domain, first_sent_at, last_sent_at, is_free_email_domain, send_count)
     SELECT lower(split_part(r, '@', 2)) AS domain,
            MIN(m.internal_date), MAX(m.internal_date), false, count(*)::int
       FROM messages m, LATERAL unnest(m.to_emails || m.cc_emails || m.bcc_emails) AS r
      WHERE m.direction = 'out'
        AND m.is_draft = false
        AND position('@' in r) > 0
        AND lower(split_part(r, '@', 2)) <> ALL($1::text[])
        AND lower(split_part(r, '@', 2)) <> ALL($2::text[])
      GROUP BY 1
     ON CONFLICT (domain) DO UPDATE SET
       first_sent_at = LEAST(contacted_domains.first_sent_at, EXCLUDED.first_sent_at),
       last_sent_at  = GREATEST(contacted_domains.last_sent_at, EXCLUDED.last_sent_at),
       send_count    = GREATEST(contacted_domains.send_count, EXCLUDED.send_count)`,
    [[...orgDomains], [...free]],
  );

  await query(
    `INSERT INTO contacted_addresses (email, first_sent_at, last_sent_at, send_count)
     SELECT lower(r), MIN(m.internal_date), MAX(m.internal_date), count(*)::int
       FROM messages m, LATERAL unnest(m.to_emails || m.cc_emails || m.bcc_emails) AS r
      WHERE m.direction = 'out'
        AND m.is_draft = false
        AND position('@' in r) > 0
        AND lower(split_part(r, '@', 2)) = ANY($1::text[])
      GROUP BY 1
     ON CONFLICT (email) DO UPDATE SET
       first_sent_at = LEAST(contacted_addresses.first_sent_at, EXCLUDED.first_sent_at),
       last_sent_at  = GREATEST(contacted_addresses.last_sent_at, EXCLUDED.last_sent_at),
       send_count    = GREATEST(contacted_addresses.send_count, EXCLUDED.send_count)`,
    [[...free]],
  );

  return contactStats();
}

export interface ContactStats { domains: number; addresses: number }

export async function contactStats(): Promise<ContactStats> {
  const rows = await query<{ domains: string; addresses: string }>(
    `SELECT (SELECT count(*)::int FROM contacted_domains) AS domains,
            (SELECT count(*)::int FROM contacted_addresses) AS addresses`,
  );
  return { domains: Number(rows[0]?.domains ?? 0), addresses: Number(rows[0]?.addresses ?? 0) };
}
