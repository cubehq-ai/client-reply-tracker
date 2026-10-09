import { query } from '../db/pool.js';
import { config } from '../lib/config.js';
import { loadClientIndex, type ClientIndex } from './clientMatch.js';
import { domainOf } from './normalize.js';

export interface OrgContext {
  orgDomains: Set<string>;
  /** Google Group / shared inbox addresses; internal senders, not clients. */
  groupAddresses: Set<string>;
  sharedMailboxes: Set<string>;
  blockedSenders: Set<string>;
  blockedDomains: Set<string>;
  allowedSenders: Set<string>;
  excludedMailboxes: Set<string>;
  excludedLabels: Set<string>;
  clients: ClientIndex;
  accountManagerByClient: Map<number, string>;
  isInternal(email: string): boolean;
  isSharedInbox(email: string): boolean;
}

export async function loadOrgContext(): Promise<OrgContext> {
  const [domains, rules, mailboxes, clients, ams, exclusions] = await Promise.all([
    query<{ domain: string; is_group: boolean }>('SELECT domain, is_group FROM org_domains'),
    query<{ type: string; value: string }>('SELECT type, value FROM rules'),
    query<{ email: string; kind: string }>("SELECT email, kind FROM mailboxes"),
    loadClientIndex(),
    query<{ client_id: string; email: string }>(
      'SELECT c.id AS client_id, u.email FROM clients c JOIN users u ON u.id = c.account_manager_user_id',
    ),
    query<{ kind: string; value: string }>('SELECT kind, value FROM exclusions'),
  ]);

  const orgDomains = new Set<string>([...config.org.domains, ...domains.map((d) => d.domain.toLowerCase())]);
  const groupAddresses = new Set<string>([
    ...config.org.groupAddresses,
    ...mailboxes.filter((m) => m.kind === 'shared').map((m) => m.email.toLowerCase()),
  ]);
  const sharedMailboxes = new Set(groupAddresses);

  const excludedMailboxes = new Set<string>([
    ...config.org.excludedMailboxes,
    ...exclusions.filter((e) => e.kind === 'mailbox').map((e) => e.value.toLowerCase()),
  ]);
  const excludedLabels = new Set<string>([
    ...config.org.excludedLabels,
    ...exclusions.filter((e) => e.kind === 'label').map((e) => e.value.toUpperCase()),
  ]);

  return {
    orgDomains,
    groupAddresses,
    sharedMailboxes,
    blockedSenders: new Set(rules.filter((r) => r.type === 'block_sender').map((r) => r.value.toLowerCase())),
    blockedDomains: new Set(rules.filter((r) => r.type === 'block_domain').map((r) => r.value.toLowerCase())),
    allowedSenders: new Set(rules.filter((r) => r.type === 'allow_sender').map((r) => r.value.toLowerCase())),
    excludedMailboxes,
    excludedLabels,
    clients,
    accountManagerByClient: new Map(ams.map((a) => [Number(a.client_id), a.email.toLowerCase()])),
    isInternal(email: string): boolean {
      const e = email.toLowerCase();
      return orgDomains.has(domainOf(e)) || groupAddresses.has(e);
    },
    isSharedInbox(email: string): boolean {
      return sharedMailboxes.has(email.toLowerCase());
    },
  };
}
