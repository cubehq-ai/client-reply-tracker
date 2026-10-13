import { describe, expect, it } from 'vitest';
import { applyFilters } from '../src/pipeline/filters.js';
import type { NormalizedMessage } from '../src/pipeline/normalize.js';

function msg(over: Partial<NormalizedMessage> = {}): NormalizedMessage {
  return {
    gmailMessageId: 'm1', gmailThreadId: 't1', mailbox: 'priya@cubehq.ai', labels: ['INBOX'],
    rfcMessageId: '<m1@acme.com>', inReplyTo: null, references: [],
    fromEmail: 'ops@acme.com', fromDomain: 'acme.com', fromName: 'Ops',
    to: ['priya@cubehq.ai'], cc: [], bcc: [], subject: 'A question', normalizedSubject: 'a question',
    internalDate: new Date(), snippet: '', bodyText: 'hi', cleanedBody: 'hi',
    headers: {}, hasCalendarPart: false, isDraft: false, attachments: [],
    ...over,
  };
}

const ctx = { isClient: false, blockedSenders: new Set<string>(), blockedDomains: new Set<string>(), allowedSenders: new Set<string>() };

describe('rule-based filtering', () => {
  it('keeps an ordinary external message', () => {
    expect(applyFilters(msg(), ctx).filtered).toBe(false);
  });

  it('filters promotional labels for non-clients', () => {
    const v = applyFilters(msg({ labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }), ctx);
    expect(v).toMatchObject({ filtered: true, reason: 'gmail_label:CATEGORY_PROMOTIONS' });
  });

  it('keeps a client message that Gmail filed under Updates', () => {
    const v = applyFilters(msg({ labels: ['INBOX', 'CATEGORY_UPDATES'] }), { ...ctx, isClient: true });
    expect(v.filtered).toBe(false);
  });

  it('still filters a client message that Gmail marked as spam', () => {
    const v = applyFilters(msg({ labels: ['SPAM'] }), { ...ctx, isClient: true });
    expect(v.reason).toBe('gmail_label:SPAM');
  });

  it('applies header rules to clients too', () => {
    const v = applyFilters(msg({ headers: { 'list-unsubscribe': '<mailto:x@y>' } }), { ...ctx, isClient: true });
    expect(v).toMatchObject({ filtered: true, reason: 'bulk' });
  });

  it('detects auto-replies by header and by subject', () => {
    expect(applyFilters(msg({ headers: { 'auto-submitted': 'auto-replied' } }), ctx).reason).toBe('auto_reply');
    expect(applyFilters(msg({ subject: 'Automatic reply: Project sync' }), ctx).reason).toBe('auto_reply');
    expect(applyFilters(msg({ subject: 'Out of office until Monday' }), ctx).reason).toBe('auto_reply');
  });

  it('treats Auto-Submitted: no as a real message', () => {
    expect(applyFilters(msg({ headers: { 'auto-submitted': 'no' } }), ctx).filtered).toBe(false);
  });

  it('detects bounces', () => {
    const v = applyFilters(msg({ fromEmail: 'mailer-daemon@googlemail.com', fromDomain: 'googlemail.com' }), ctx);
    expect(v).toMatchObject({ reason: 'bounce', isBounce: true });
  });

  it('detects calendar responses', () => {
    expect(applyFilters(msg({ subject: 'Accepted: Quarterly review' }), ctx).reason).toBe('calendar');
    expect(applyFilters(msg({ hasCalendarPart: true }), ctx).reason).toBe('calendar');
  });

  it('filters noreply-style senders', () => {
    expect(applyFilters(msg({ fromEmail: 'no-reply@stripe.com' }), ctx).reason).toBe('noreply_sender');
    expect(applyFilters(msg({ fromEmail: 'notifications@github.com' }), ctx).reason).toBe('noreply_sender');
  });

  it('does not mistake a person for a noreply address', () => {
    expect(applyFilters(msg({ fromEmail: 'noreen@acme.com' }), ctx).filtered).toBe(false);
  });

  it('honours block rules and lets allow rules win', () => {
    const blocked = { ...ctx, blockedDomains: new Set(['acme.com']) };
    expect(applyFilters(msg(), blocked).reason).toBe('blocked_domain');
    const allowed = { ...blocked, allowedSenders: new Set(['ops@acme.com']) };
    expect(applyFilters(msg(), allowed).filtered).toBe(false);
  });
});
