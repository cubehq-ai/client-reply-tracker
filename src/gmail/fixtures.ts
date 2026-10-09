import type { RawMessage } from './types.js';

/** Fixture mailboxes. `support@` is a Google Group / shared inbox (SPEC 12). */
export const FIXTURE_USERS = [
  { email: 'dev@cubehq.ai', name: 'Dev Admin', suspended: false, isAdmin: true },
  { email: 'priya@cubehq.ai', name: 'Priya Nair', suspended: false, managerEmail: 'dev@cubehq.ai' },
  { email: 'rahul@cubehq.ai', name: 'Rahul Menon', suspended: false, managerEmail: 'dev@cubehq.ai' },
  { email: 'support@cubehq.ai', name: 'Support Inbox', suspended: false },
  { email: 'former@cubehq.ai', name: 'Former Employee', suspended: true, managerEmail: 'dev@cubehq.ai' },
];

export const FIXTURE_CLIENTS = [
  { externalId: 'c-acme', name: 'Acme Corp', tier: 'gold', accountManager: 'priya@cubehq.ai', domains: ['acme.com'], contacts: [] as string[] },
  { externalId: 'c-northwind', name: 'Northwind Trading', tier: 'silver', accountManager: 'rahul@cubehq.ai', domains: ['northwind.io'], contacts: [] as string[] },
  { externalId: 'c-globex', name: 'Globex', tier: 'silver', accountManager: 'priya@cubehq.ai', domains: ['globex.co'], contacts: [] as string[] },
  // Personal-Gmail client: email-level mapping only, never a domain (SPEC 4.4).
  { externalId: 'c-zenith', name: 'Zenith Retail', tier: 'bronze', accountManager: 'rahul@cubehq.ai', domains: [] as string[], contacts: ['zenith.founder@gmail.com'] },
];

const DAY = 86_400_000;
const HOUR = 3_600_000;
const now = Date.UTC(2026, 9, 9, 6, 0, 0); // fixed clock so fixtures are deterministic

interface Spec {
  /** Which mailboxes hold a copy of this message. */
  mailboxes: string[];
  thread: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  agoMs: number;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  labels?: string[];
  extraHeaders?: Record<string, string>;
  hasCalendarPart?: boolean;
  isDraft?: boolean;
}

export const FIXTURE_MESSAGES: Spec[] = [
  // T1 — Acme asks a question. Nobody has replied. Expect: needs_reply, owner priya.
  {
    mailboxes: ['priya@cubehq.ai'], thread: 't-acme-1', messageId: '<acme-1@acme.com>',
    from: 'ops@acme.com', to: ['priya@cubehq.ai'], cc: ['rahul@cubehq.ai'],
    subject: 'Q3 invoice discrepancy', agoMs: 30 * HOUR, labels: ['INBOX', 'UNREAD'],
    body: 'Hi Priya,\n\nThe Q3 invoice shows 240 units but we received 220. Can you confirm which is correct and reissue if needed?\n\nThanks,\nOps',
  },

  // T2 — Northwind writes to Priya, Rahul replies from HIS mailbox.
  // Expect: replied, via cross-mailbox reply detection (SPEC 6).
  {
    mailboxes: ['priya@cubehq.ai'], thread: 't-nw-1', messageId: '<nw-1@northwind.io>',
    from: 'claire@northwind.io', to: ['priya@cubehq.ai'],
    subject: 'Renewal terms', agoMs: 3 * DAY, labels: ['INBOX'],
    body: 'Could you send over the renewal terms for next year?',
  },
  {
    mailboxes: ['rahul@cubehq.ai'], thread: 't-nw-1-rahul', messageId: '<nw-2@cubehq.ai>',
    from: 'rahul@cubehq.ai', to: ['claire@northwind.io'], cc: ['priya@cubehq.ai'],
    subject: 'Re: Renewal terms', agoMs: 3 * DAY - 2 * HOUR, labels: ['SENT'],
    inReplyTo: '<nw-1@northwind.io>', references: ['<nw-1@northwind.io>'],
    body: 'Attaching the renewal terms — same rate card as last year.',
  },

  // T3 — Client mail that Gmail filed under Updates. The client-domain exception
  // must keep it visible (SPEC 4 step 3). Expect: needs_reply.
  {
    mailboxes: ['priya@cubehq.ai'], thread: 't-globex-1', messageId: '<globex-1@mail.globex.co>',
    from: 'dana@mail.globex.co', to: ['priya@cubehq.ai'],
    subject: 'Integration timeline?', agoMs: 10 * HOUR, labels: ['INBOX', 'CATEGORY_UPDATES'],
    body: 'When can we expect the integration to go live? We are blocked on our side.',
  },

  // T4 — Pure promotion. Expect: auto_ignored (labels + List-Unsubscribe).
  {
    mailboxes: ['priya@cubehq.ai'], thread: 't-promo-1', messageId: '<promo-1@marketing.example>',
    from: 'offers@marketing.example', to: ['priya@cubehq.ai'],
    subject: 'Last chance: 40% off analytics seats', agoMs: 5 * HOUR,
    labels: ['INBOX', 'CATEGORY_PROMOTIONS'],
    extraHeaders: { 'list-unsubscribe': '<mailto:unsub@marketing.example>', precedence: 'bulk' },
    body: 'Our biggest sale of the year ends tonight.',
  },

  // T5 — Out-of-office from a client address. Header rules still apply to clients
  // (SPEC 4 step 3 exception). Expect: auto_ignored.
  {
    mailboxes: ['priya@cubehq.ai'], thread: 't-ooo-1', messageId: '<ooo-1@acme.com>',
    from: 'dana@acme.com', to: ['priya@cubehq.ai'],
    subject: 'Automatic reply: Project sync', agoMs: 6 * HOUR, labels: ['INBOX'],
    extraHeaders: { 'auto-submitted': 'auto-replied', 'x-autoreply': 'yes' },
    body: 'I am out of office until Monday with limited access to email.',
  },

  // T6 — Bounce of our own reply. Expect: auto_ignored as a message, and the
  // conversation it bounced from stays needs_reply (SPEC 12).
  {
    mailboxes: ['rahul@cubehq.ai'], thread: 't-bounce-1', messageId: '<bounce-1@cubehq.ai>',
    from: 'mailer-daemon@googlemail.com', to: ['rahul@cubehq.ai'],
    subject: 'Delivery Status Notification (Failure)', agoMs: 2 * HOUR, labels: ['INBOX'],
    extraHeaders: { 'auto-submitted': 'auto-replied', 'content-type': 'multipart/report; report-type=delivery-status' },
    body: 'Address not found: dana@globex.invalid',
  },

  // T7 — Client writing from a personal Gmail, no mapping yet. Expect: Unmatched.
  {
    mailboxes: ['support@cubehq.ai'], thread: 't-personal-1', messageId: '<personal-1@gmail.com>',
    from: 'random.person@gmail.com', to: ['support@cubehq.ai'],
    subject: 'Question about your pricing', agoMs: 8 * HOUR, labels: ['INBOX'],
    body: 'Hi, do you offer a startup discount? Who should I talk to?',
  },

  // T8 — We replied, client said "Thanks!". Expect: fyi, and it must NOT reopen
  // the replied item (SPEC 12, decision 4).
  {
    mailboxes: ['priya@cubehq.ai'], thread: 't-thanks-1', messageId: '<thanks-0@acme.com>',
    from: 'ops@acme.com', to: ['priya@cubehq.ai'],
    subject: 'Shipping address update', agoMs: 2 * DAY, labels: ['INBOX'],
    body: 'Please update our shipping address to 14 Harbour Road.',
  },
  {
    mailboxes: ['priya@cubehq.ai'], thread: 't-thanks-1', messageId: '<thanks-1@cubehq.ai>',
    from: 'priya@cubehq.ai', to: ['ops@acme.com'],
    subject: 'Re: Shipping address update', agoMs: 2 * DAY - HOUR, labels: ['SENT'],
    inReplyTo: '<thanks-0@acme.com>', references: ['<thanks-0@acme.com>'],
    body: 'Done — updated in our system.',
  },
  {
    mailboxes: ['priya@cubehq.ai'], thread: 't-thanks-1', messageId: '<thanks-2@acme.com>',
    from: 'ops@acme.com', to: ['priya@cubehq.ai'],
    subject: 'Re: Shipping address update', agoMs: 2 * DAY - 2 * HOUR, labels: ['INBOX'],
    inReplyTo: '<thanks-1@cubehq.ai>', references: ['<thanks-0@acme.com>', '<thanks-1@cubehq.ai>'],
    body: 'Thanks!',
  },

  // T9 — Replied, then the client wrote again. Expect: reopened to needs_reply
  // with reopen_count 1 (SPEC 5).
  {
    mailboxes: ['rahul@cubehq.ai'], thread: 't-reopen-1', messageId: '<reopen-0@northwind.io>',
    from: 'claire@northwind.io', to: ['rahul@cubehq.ai'],
    subject: 'Onboarding checklist', agoMs: 4 * DAY, labels: ['INBOX'],
    body: 'Can you share the onboarding checklist?',
  },
  {
    mailboxes: ['rahul@cubehq.ai'], thread: 't-reopen-1', messageId: '<reopen-1@cubehq.ai>',
    from: 'rahul@cubehq.ai', to: ['claire@northwind.io'],
    subject: 'Re: Onboarding checklist', agoMs: 4 * DAY - 3 * HOUR, labels: ['SENT'],
    inReplyTo: '<reopen-0@northwind.io>', references: ['<reopen-0@northwind.io>'],
    body: 'Here it is, let me know if anything is unclear.',
  },
  {
    mailboxes: ['rahul@cubehq.ai'], thread: 't-reopen-1', messageId: '<reopen-2@northwind.io>',
    from: 'claire@northwind.io', to: ['rahul@cubehq.ai'],
    subject: 'Re: Onboarding checklist', agoMs: 20 * HOUR, labels: ['INBOX'],
    inReplyTo: '<reopen-1@cubehq.ai>', references: ['<reopen-0@northwind.io>', '<reopen-1@cubehq.ai>'],
    body: 'Step 4 fails for our EU entity — what should we do instead?',
  },

  // T10 — One message to the support@ group, delivered to two member mailboxes.
  // Expect: ONE item, deduped by Message-ID (SPEC 12).
  {
    mailboxes: ['support@cubehq.ai', 'priya@cubehq.ai', 'rahul@cubehq.ai'],
    thread: 't-group-1', messageId: '<group-1@acme.com>',
    from: 'finance@acme.com', to: ['support@cubehq.ai'],
    subject: 'Need a W-9 for our records', agoMs: 26 * HOUR, labels: ['INBOX'],
    body: 'Could someone send over a signed W-9? We need it before we can process payment.',
  },

  // T11 — Internal-only thread. Expect: ignored entirely (SPEC 4 step 2).
  {
    mailboxes: ['priya@cubehq.ai'], thread: 't-internal-1', messageId: '<internal-1@cubehq.ai>',
    from: 'rahul@cubehq.ai', to: ['priya@cubehq.ai'],
    subject: 'Standup moved to 10:30', agoMs: 4 * HOUR, labels: ['INBOX'],
    body: 'Standup is at 10:30 tomorrow.',
  },

  // T12 — Client mail forwarded internally with no external recipient. The
  // forward must NOT count as a reply (SPEC 6). Expect: still needs_reply.
  {
    mailboxes: ['priya@cubehq.ai'], thread: 't-fwd-1', messageId: '<fwd-0@globex.co>',
    from: 'sam@globex.co', to: ['priya@cubehq.ai'],
    subject: 'Contract redlines', agoMs: 28 * HOUR, labels: ['INBOX'],
    body: 'Our legal team has redlines on section 7. Can we get a call this week?',
  },
  {
    mailboxes: ['priya@cubehq.ai'], thread: 't-fwd-1', messageId: '<fwd-1@cubehq.ai>',
    from: 'priya@cubehq.ai', to: ['rahul@cubehq.ai'],
    subject: 'Fwd: Contract redlines', agoMs: 27 * HOUR, labels: ['SENT'],
    inReplyTo: '<fwd-0@globex.co>', references: ['<fwd-0@globex.co>'],
    body: 'FYI — can you handle this one? I am travelling.',
  },

  // T13 — A draft reply. Drafts never count as a reply (SPEC 6).
  {
    mailboxes: ['priya@cubehq.ai'], thread: 't-acme-1', messageId: '<acme-draft@cubehq.ai>',
    from: 'priya@cubehq.ai', to: ['ops@acme.com'],
    subject: 'Re: Q3 invoice discrepancy', agoMs: 1 * HOUR, labels: ['DRAFT'], isDraft: true,
    inReplyTo: '<acme-1@acme.com>', references: ['<acme-1@acme.com>'],
    body: 'Checking with the warehouse now,',
  },

  // T14 — Calendar invite response. Expect: auto_ignored (SPEC 4 step 3).
  {
    mailboxes: ['rahul@cubehq.ai'], thread: 't-cal-1', messageId: '<cal-1@northwind.io>',
    from: 'claire@northwind.io', to: ['rahul@cubehq.ai'],
    subject: 'Accepted: Quarterly review', agoMs: 3 * HOUR, labels: ['INBOX'],
    hasCalendarPart: true,
    body: 'Claire has accepted this invitation.',
  },

  // T15 — A high-priority complaint, to exercise priority + alerting.
  {
    mailboxes: ['priya@cubehq.ai'], thread: 't-urgent-1', messageId: '<urgent-1@acme.com>',
    from: 'cto@acme.com', to: ['priya@cubehq.ai', 'support@cubehq.ai'],
    subject: 'URGENT: production sync has been down since Monday', agoMs: 50 * HOUR, labels: ['INBOX', 'IMPORTANT'],
    body: 'This is the third day our production sync is failing and we have had no update. This is unacceptable — we need someone on a call today.',
  },
];

export function buildFixtureMessages(): Map<string, RawMessage[]> {
  const byMailbox = new Map<string, RawMessage[]>();
  let counter = 1000;

  for (const spec of FIXTURE_MESSAGES) {
    for (const mailbox of spec.mailboxes) {
      counter += 1;
      const headers: Record<string, string> = {
        from: spec.from,
        to: spec.to.join(', '),
        subject: spec.subject,
        date: new Date(now - spec.agoMs).toUTCString(),
        'message-id': spec.messageId,
        ...(spec.cc?.length ? { cc: spec.cc.join(', ') } : {}),
        ...(spec.inReplyTo ? { 'in-reply-to': spec.inReplyTo } : {}),
        ...(spec.references?.length ? { references: spec.references.join(' ') } : {}),
        ...(spec.extraHeaders ?? {}),
      };
      const msg: RawMessage = {
        id: `fix-${counter}`,
        // Gmail thread ids differ per mailbox, so derive one per mailbox (SPEC 2).
        threadId: `${spec.thread}--${mailbox.split('@')[0]}`,
        labelIds: spec.labels ?? ['INBOX'],
        internalDateMs: now - spec.agoMs,
        headers,
        snippet: spec.body.slice(0, 120),
        bodyText: spec.body,
        hasCalendarPart: spec.hasCalendarPart ?? false,
        attachments: [],
        isDraft: spec.isDraft ?? false,
      };
      const arr = byMailbox.get(mailbox) ?? [];
      arr.push(msg);
      byMailbox.set(mailbox, arr);
    }
  }
  for (const arr of byMailbox.values()) arr.sort((a, b) => b.internalDateMs - a.internalDateMs);
  return byMailbox;
}

export const FIXTURE_NOW = now;
