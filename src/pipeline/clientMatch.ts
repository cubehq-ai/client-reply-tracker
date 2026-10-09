import { query } from '../db/pool.js';
import { domainOf } from './normalize.js';

export interface ClientMatch {
  clientId: number | null;
  matchedOn: 'domain' | 'email' | 'subdomain' | 'participant' | null;
  matchedValue: string | null;
}

export interface ClientIndex {
  byDomain: Map<string, number>;
  byEmail: Map<string, number>;
  freeDomains: Set<string>;
}

export async function loadClientIndex(): Promise<ClientIndex> {
  const [domains, contacts, free] = await Promise.all([
    query<{ domain: string; client_id: string }>('SELECT domain, client_id FROM client_domains'),
    query<{ email: string; client_id: string }>('SELECT email, client_id FROM client_contacts'),
    query<{ domain: string }>('SELECT domain FROM free_email_domains'),
  ]);
  return {
    byDomain: new Map(domains.map((d) => [d.domain.toLowerCase(), Number(d.client_id)])),
    byEmail: new Map(contacts.map((c) => [c.email.toLowerCase(), Number(c.client_id)])),
    freeDomains: new Set(free.map((f) => f.domain.toLowerCase())),
  };
}

/**
 * Client matching (SPEC 4 step 4), in priority order:
 *   1. exact sender domain, 2. exact sender email, 3. subdomain,
 *   4. any other external participant on the thread, 5. unmatched.
 *
 * Free email domains are never matched as a whole domain — only the explicit
 * email-level mapping can match a gmail.com address.
 */
export function matchClient(
  index: ClientIndex,
  senderEmail: string,
  otherExternalParticipants: string[] = [],
): ClientMatch {
  const senderDomain = domainOf(senderEmail);

  const byEmail = index.byEmail.get(senderEmail.toLowerCase());
  if (byEmail) return { clientId: byEmail, matchedOn: 'email', matchedValue: senderEmail };

  if (!index.freeDomains.has(senderDomain)) {
    const exact = index.byDomain.get(senderDomain);
    if (exact) return { clientId: exact, matchedOn: 'domain', matchedValue: senderDomain };

    // mail.acme.com -> acme.com
    const parts = senderDomain.split('.');
    for (let i = 1; i < parts.length - 1; i++) {
      const parent = parts.slice(i).join('.');
      const hit = index.byDomain.get(parent);
      if (hit) return { clientId: hit, matchedOn: 'subdomain', matchedValue: parent };
    }
  }

  for (const participant of otherExternalParticipants) {
    const p = participant.toLowerCase();
    const viaEmail = index.byEmail.get(p);
    if (viaEmail) return { clientId: viaEmail, matchedOn: 'participant', matchedValue: p };
    const d = domainOf(p);
    if (index.freeDomains.has(d)) continue;
    const viaDomain = index.byDomain.get(d);
    if (viaDomain) return { clientId: viaDomain, matchedOn: 'participant', matchedValue: d };
  }

  return { clientId: null, matchedOn: null, matchedValue: null };
}
