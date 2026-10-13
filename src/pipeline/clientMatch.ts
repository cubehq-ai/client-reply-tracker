import { query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { domainOf } from './normalize.js';

export interface ClientMatch {
  clientId: number | null;
  matchedOn: 'domain' | 'email' | 'subdomain' | 'pattern' | 'participant' | null;
  matchedValue: string | null;
}

export interface ClientPattern {
  clientId: number;
  pattern: string;
  regex: RegExp;
  priority: number;
}

export interface ClientIndex {
  byDomain: Map<string, number>;
  byEmail: Map<string, number>;
  patterns: ClientPattern[];
  freeDomains: Set<string>;
}

export async function loadClientIndex(): Promise<ClientIndex> {
  const [domains, contacts, patterns, free] = await Promise.all([
    query<{ domain: string; client_id: string }>('SELECT domain, client_id FROM client_domains'),
    query<{ email: string; client_id: string }>('SELECT email, client_id FROM client_contacts'),
    query<{ client_id: string; pattern: string; priority: number }>(
      'SELECT client_id, pattern, priority FROM client_patterns ORDER BY priority ASC, id ASC',
    ),
    query<{ domain: string }>('SELECT domain FROM free_email_domains'),
  ]);

  const compiled: ClientPattern[] = [];
  for (const p of patterns) {
    try {
      compiled.push({ clientId: Number(p.client_id), pattern: p.pattern, regex: new RegExp(p.pattern, 'i'), priority: p.priority });
    } catch {
      // A bad pattern must not take the whole pipeline down; skip it.
      logger.warn({ pattern: p.pattern, clientId: p.client_id }, 'ignoring an invalid client pattern');
    }
  }

  return {
    byDomain: new Map(domains.map((d) => [d.domain.toLowerCase(), Number(d.client_id)])),
    byEmail: new Map(contacts.map((c) => [c.email.toLowerCase(), Number(c.client_id)])),
    patterns: compiled,
    freeDomains: new Set(free.map((f) => f.domain.toLowerCase())),
  };
}

/**
 * Client matching (SPEC 4 step 4), in priority order:
 *   1. exact sender email, 2. regex pattern, 3. exact sender domain,
 *   4. subdomain, 5. any other external participant, 6. unmatched.
 *
 * Entirely deterministic — a lookup table plus explicit regexes. No model is
 * involved in deciding who a client is; the classifier only ever decides
 * whether a message needs a reply.
 *
 * Free email domains are never matched as a whole domain: only an explicit
 * email-level mapping, or a pattern, can match a gmail.com address.
 */
export function matchClient(
  index: ClientIndex,
  senderEmail: string,
  otherExternalParticipants: string[] = [],
): ClientMatch {
  const sender = senderEmail.toLowerCase();
  const senderDomain = domainOf(sender);

  const byEmail = index.byEmail.get(sender);
  if (byEmail) return { clientId: byEmail, matchedOn: 'email', matchedValue: senderEmail };

  // Explicit regexes beat the domain table, so one shared domain can be split
  // between clients by local part.
  for (const p of index.patterns) {
    if (p.regex.test(sender)) return { clientId: p.clientId, matchedOn: 'pattern', matchedValue: p.pattern };
  }

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
