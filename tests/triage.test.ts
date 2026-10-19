import { describe, expect, it } from 'vitest';
import { triage } from '../src/pipeline/triage.js';
import type { NormalizedMessage } from '../src/pipeline/normalize.js';
import type { ClientMatch } from '../src/pipeline/clientMatch.js';

function msg(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    gmailMessageId: 'm1', gmailThreadId: 't1', mailbox: 'priya@cubehq.ai', labels: ['INBOX'],
    rfcMessageId: '<m1@acme.com>', inReplyTo: null, references: [],
    fromEmail: 'ops@acme.com', fromDomain: 'acme.com', fromName: 'Ops',
    to: ['priya@cubehq.ai'], cc: [], bcc: [], subject: 'A question', normalizedSubject: 'a question',
    internalDate: new Date(), snippet: '', bodyText: 'hi', bodyHtml: null, cleanedBody: 'hi',
    headers: {}, hasCalendarPart: false, isDraft: false, attachments: [],
    ...over,
  };
}

const CLIENT: ClientMatch = { clientId: 1, matchedOn: 'domain', matchedValue: 'acme.com' };
const NO_CLIENT: ClientMatch = { clientId: null, matchedOn: null, matchedValue: null };

function ctx(over: Partial<Parameters<typeof triage>[2]> = {}) {
  return {
    isClient: false,
    blockedSenders: new Set<string>(),
    blockedDomains: new Set<string>(),
    contacts: {
      domains: new Set<string>(), addresses: new Set<string>(), freeDomains: new Set(['gmail.com']),
      hasContacted: () => false,
    },
    ...over,
  };
}

describe('1. client mail', () => {
  it('keeps a client message Gmail filed under Promotions', () => {
    const r = triage(msg({ labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }), CLIENT, ctx({ isClient: true }));
    expect(r).toMatchObject({ branch: 'client', classify: true, reason: null });
  });

  it('keeps a client message Gmail filed under Updates', () => {
    const r = triage(msg({ labels: ['CATEGORY_UPDATES'] }), CLIENT, ctx({ isClient: true }));
    expect(r.classify).toBe(true);
  });

  it('still drops a client out-of-office by header', () => {
    const r = triage(msg({ headers: { 'auto-submitted': 'auto-replied' } }), CLIENT, ctx({ isClient: true }));
    expect(r).toMatchObject({ reason: 'filtered', filterReason: 'auto_reply', classify: false });
  });

  it('still drops a bounce', () => {
    const r = triage(msg({ fromEmail: 'mailer-daemon@acme.com', subject: 'Undeliverable' }), CLIENT, ctx({ isClient: true }));
    expect(r.filterReason).toBe('bounce');
  });

  it('a block rule beats client status', () => {
    const r = triage(msg(), CLIENT, ctx({ isClient: true, blockedDomains: new Set(['acme.com']) }));
    expect(r.filterReason).toBe('blocked_domain');
  });
});

describe('2. spam, promotional, automated', () => {
  const nonClient = ctx();

  it('filters a newsletter, without a model call', () => {
    const r = triage(msg({ fromEmail: 'news@marketing.example', fromDomain: 'marketing.example', headers: { 'list-unsubscribe': '<mailto:x@y>' } }), NO_CLIENT, nonClient);
    expect(r).toMatchObject({ branch: 'bulk', reason: 'filtered', classify: false });
  });

  it('filters Gmail category labels for non-clients', () => {
    expect(triage(msg({ labels: ['CATEGORY_PROMOTIONS'] }), NO_CLIENT, nonClient).filterReason).toBe('gmail_label:CATEGORY_PROMOTIONS');
  });

  it('filters automated senders', () => {
    expect(triage(msg({ fromEmail: 'no-reply@tool.example' }), NO_CLIENT, nonClient).filterReason).toBe('automated_sender');
    expect(triage(msg({ fromEmail: 'notifications@tool.example' }), NO_CLIENT, nonClient).filterReason).toBe('automated_sender');
  });

  it('filters calendar invitations', () => {
    expect(triage(msg({ hasCalendarPart: true }), NO_CLIENT, nonClient).filterReason).toBe('calendar');
  });

  it('does not mistake a person for an automated sender', () => {
    const contacted = ctx({ contacts: { ...ctx().contacts, hasContacted: () => true } });
    expect(triage(msg({ fromEmail: 'noreen@person.example' }), NO_CLIENT, contacted).classify).toBe(true);
  });
});

describe('3. non-client mail from a real person', () => {
  it('surfaces someone at a domain we have written to, flagged unmatched', () => {
    const known = ctx({ contacts: { ...ctx().contacts, hasContacted: () => true } });
    const r = triage(msg({ fromEmail: 'new@supplier.example', fromDomain: 'supplier.example' }), NO_CLIENT, known);
    expect(r).toMatchObject({ branch: 'known_contact', classify: true, reason: null, unmatchedClient: true });
  });

  it('filters cold outreach from a domain we have never written to', () => {
    const r = triage(msg({ fromEmail: 'sales@cold.example', fromDomain: 'cold.example' }), NO_CLIENT, ctx());
    expect(r).toMatchObject({ branch: 'cold', classify: false, reason: 'filtered', filterReason: 'no_prior_contact' });
  });

  it('never calls the classifier on either filtered branch', () => {
    expect(triage(msg({ fromEmail: 'sales@cold.example' }), NO_CLIENT, ctx()).classify).toBe(false);
    expect(triage(msg({ headers: { 'list-id': '<x>' } }), NO_CLIENT, ctx()).classify).toBe(false);
  });
});
