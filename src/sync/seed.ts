import { query } from '../db/pool.js';
import { config } from '../lib/config.js';
import { logger } from '../lib/logger.js';

/** Domains that must never be attached to a client wholesale (SPEC 4.4). */
const FREE_EMAIL_DOMAINS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'ymail.com', 'aol.com', 'icloud.com',
  'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'mail.com',
  'zoho.com', 'yandex.com', 'yandex.ru', 'fastmail.com', 'hey.com', 'tutanota.com',
  'rediffmail.com', 'qq.com', '163.com', '126.com', 'naver.com', 'daum.net',
];

export async function seedReferenceData(): Promise<void> {
  if (config.org.domains.length > 0) {
    await query(
      `INSERT INTO org_domains (domain) SELECT unnest($1::text[]) ON CONFLICT (domain) DO NOTHING`,
      [config.org.domains],
    );
  }
  if (config.org.groupAddresses.length > 0) {
    // Group addresses are internal senders; record their domains too.
    const groupDomains = [...new Set(config.org.groupAddresses.map((a) => a.split('@')[1]).filter(Boolean) as string[])];
    if (groupDomains.length) {
      await query(`INSERT INTO org_domains (domain, is_group) SELECT unnest($1::text[]), true ON CONFLICT (domain) DO NOTHING`, [groupDomains]);
    }
  }
  await query(
    `INSERT INTO free_email_domains (domain) SELECT unnest($1::text[]) ON CONFLICT (domain) DO NOTHING`,
    [FREE_EMAIL_DOMAINS],
  );

  for (const [kind, values] of [
    ['mailbox', config.org.excludedMailboxes],
    ['label', config.org.excludedLabels],
  ] as const) {
    if (values.length === 0) continue;
    await query(
      `INSERT INTO exclusions (kind, value, reason) SELECT $1, unnest($2::text[]), 'from env' ON CONFLICT (kind, value) DO NOTHING`,
      [kind, values],
    );
  }

  logger.info({ orgDomains: config.org.domains.length }, 'reference data seeded');
}
