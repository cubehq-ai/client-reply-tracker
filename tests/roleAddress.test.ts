import { describe, expect, it } from 'vitest';
import { triage } from '../src/pipeline/triage.js';
import type { NormalizedMessage } from '../src/pipeline/normalize.js';

/**
 * Promotional mail reached the queue through the previously-contacted branch:
 * someone once emailed a vendor, so every newsletter from that domain arrived
 * as an unmatched item needing a reply. No model call decides this.
 */
const msg = (from: string): NormalizedMessage => ({
  fromEmail: from,
  fromDomain: from.split('@')[1]!,
  subject: 'Our October product update',
  labels: [],
  headers: {},
  hasCalendarPart: false,
} as unknown as NormalizedMessage);

// Every non-client sender has been emailed before, so only the role check can
// filter them: this is exactly the case that was leaking.
const ctx = {
  isClient: false,
  blockedSenders: new Set<string>(),
  blockedDomains: new Set<string>(),
  contacts: { hasContacted: () => true } as any,
};

const ROLES = [
  'info@vendor.com', 'hello@vendor.com', 'support@vendor.com', 'sales@vendor.com',
  'marketing@vendor.com', 'billing@vendor.com', 'newsletter@vendor.com',
  'careers@vendor.com', 'alerts@vendor.com', 'webmaster@vendor.com',
  'feedback@vendor.com', 'orders@vendor.com', 'team@vendor.com',
  'news-uk@vendor.com', 'support+ticket123@vendor.com', 'sales.emea@vendor.com',
  'customer.care@vendor.com', 'no.reply@vendor.com',
];

const PEOPLE = [
  'priya@vendor.com', 'j.smith@vendor.com', 'anna-maria@vendor.com',
  'rahul.menon2@vendor.com', 'li.wei@vendor.com', 'o.brien@vendor.com',
  'mary@vendor.com', 'sasi@vendor.com',
];

describe('role addresses are filtered without a model call', () => {
  for (const from of ROLES) {
    it(`filters ${from}`, () => {
      const r = triage(msg(from), { clientId: null } as any, ctx as any);
      expect(r.classify).toBe(false);
      expect(r.reason).toBe('filtered');
    });
  }

  for (const from of PEOPLE) {
    it(`keeps ${from}`, () => {
      const r = triage(msg(from), { clientId: null } as any, ctx as any);
      expect(r.classify).toBe(true);
      expect(r.reason).toBeNull();
    });
  }

  it('never filters a client on a role address', () => {
    const r = triage(msg('support@acme.com'), { clientId: 1 } as any, { ...ctx, isClient: true } as any);
    expect(r.branch).toBe('client');
    expect(r.classify).toBe(true);
  });
});
