import type { ClientMatch } from './clientMatch.js';
import type { ContactIndex } from './contacted.js';
import type { NormalizedMessage } from './normalize.js';

/**
 * Decides what happens to one external message (CLAUDE.md override 2).
 *
 * Three branches, first match wins. The ordering matters: client mail is
 * recognised before the spam rules can touch it, because clients land in
 * Promotions and Updates often enough that label filters would lose real work.
 */

export type TriageBranch = 'client' | 'bulk' | 'known_contact' | 'cold';

export interface TriageResult {
  branch: TriageBranch;
  /** True when the classifier should run. Nothing else costs a model call. */
  classify: boolean;
  /** Set when the message is closed without classification. */
  reason: 'filtered' | null;
  filterReason: string | null;
  unmatchedClient: boolean;
}

const BULK_LABELS = new Set(['SPAM', 'CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS']);

const AUTOMATED_LOCAL = /^(no[-._]?reply|do[-._]?not[-._]?reply|donotreply|notifications?|mailer[-._]?daemon|postmaster|bounces?)([-._+].*)?$/i;

/**
 * Role addresses: a department, a product or a mailing list, never a person.
 *
 * Promotional mail reaches the queue through the previously-contacted branch:
 * someone once emailed a vendor, the vendor's domain is now "known", and every
 * newsletter from it arrives as an unmatched item needing a reply. Senders
 * like these are not people and do not wait on an answer.
 *
 * Deliberately a denylist of non-names rather than a guess at what a human
 * name looks like. "j.smith2" and "anna-maria" are people; no pattern
 * separates them from "info" without throwing away real senders.
 *
 * Client mail never reaches this check: a client's own support@ or
 * accounts@ is a real conversation, and branch 1 returns before bulk rules.
 */
const ROLE_LOCAL = new Set([
  // Front desk
  'info', 'information', 'hello', 'hallo', 'hi', 'hey', 'contact', 'contactus',
  'enquiry', 'enquiries', 'inquiry', 'inquiries', 'ask', 'general', 'office',
  'reception', 'mail', 'email', 'mailbox', 'inbox', 'webmail',
  // Support
  'support', 'help', 'helpdesk', 'desk', 'service', 'services', 'customerservice',
  'customercare', 'customersuccess', 'care', 'assist', 'assistance', 'ticket',
  'tickets', 'issues',
  // Commercial
  'sales', 'marketing', 'promo', 'promotions', 'offers', 'deals', 'partners',
  'partnerships', 'business', 'bizdev', 'leads', 'crm', 'outreach', 'growth',
  // Money
  'billing', 'invoice', 'invoices', 'invoicing', 'accounts', 'accounting',
  'accountspayable', 'accountsreceivable', 'payments', 'payment', 'finance',
  'financial', 'receipts', 'receipt', 'orders', 'order', 'refunds', 'refund',
  'subscriptions', 'subscription',
  // Content and lists
  'newsletter', 'newsletters', 'news', 'updates', 'update', 'digest', 'blog',
  'press', 'media', 'pr', 'marketingteam', 'campaign', 'campaigns', 'events',
  'event', 'webinar', 'webinars', 'community', 'social', 'insights', 'weekly',
  'monthly',
  // Automated systems
  'alert', 'alerts', 'notify', 'notice', 'notices', 'reminder', 'reminders',
  'system', 'sysadmin', 'admin', 'administrator', 'root', 'daemon', 'robot',
  'bot', 'bots', 'automated', 'automation', 'auto', 'mailer', 'mailing',
  'mailerdaemon', 'relay', 'smtp', 'server', 'status', 'monitoring', 'monitor',
  // Internet role accounts (RFC 2142 and friends)
  'webmaster', 'hostmaster', 'abuse', 'security', 'privacy', 'compliance',
  'legal', 'dpo', 'gdpr',
  // People ops
  'hr', 'people', 'careers', 'career', 'jobs', 'job', 'recruiting',
  'recruitment', 'recruiter', 'talent', 'hiring', 'apply', 'applications',
  // Product lifecycle
  'welcome', 'onboarding', 'getstarted', 'feedback', 'survey', 'surveys',
  'review', 'reviews', 'rating', 'ratings', 'invite', 'invites', 'invitation',
  'invitations', 'verify', 'verification', 'confirm', 'confirmation',
  'password', 'account', 'login', 'signup', 'register', 'registration',
  'unsubscribe', 'optout', 'preferences', 'messages', 'message', 'reply',
  'replies', 'team', 'teams', 'group', 'groups', 'list', 'lists',
  'shipping', 'delivery', 'tracking', 'dispatch', 'logistics',
]);

/**
 * True when the local part is a role rather than a person.
 *
 * Suffixes are stripped so "support+tag", "news-uk" and "info.us" are caught,
 * and a leading "the" is ignored because "theteam@" is the same sender.
 */
function isRoleAddress(local: string): boolean {
  const bare = local.toLowerCase().split(/[+]/)[0] ?? '';
  if (ROLE_LOCAL.has(bare.replace(/[-._]/g, ''))) return true;
  // "news-uk", "sales.emea", "support_2024": the head decides.
  const head = bare.split(/[-._]/)[0] ?? '';
  return head.length > 1 && ROLE_LOCAL.has(head);
}

const AUTOREPLY_SUBJECT = /\b(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|vacation reply|on leave)\b/i;

const BOUNCE_SUBJECT = /\b(delivery status notification|undeliverable|returned mail|mail delivery (failed|subsystem)|message not delivered)\b/i;

export interface TriageContext {
  isClient: boolean;
  blockedSenders: Set<string>;
  blockedDomains: Set<string>;
  contacts: ContactIndex;
}

/** Header-level signals that apply even to a client's own address. */
function automatedSignal(msg: NormalizedMessage): string | null {
  const h = msg.headers;
  const autoSubmitted = (h['auto-submitted'] ?? '').toLowerCase();

  if (/mailer-daemon|postmaster/i.test(msg.fromEmail) || BOUNCE_SUBJECT.test(msg.subject)
      || (h['content-type'] ?? '').includes('report-type=delivery-status')) {
    return 'bounce';
  }
  if ((autoSubmitted !== '' && autoSubmitted !== 'no') || 'x-autoreply' in h || AUTOREPLY_SUBJECT.test(msg.subject)) {
    return 'auto_reply';
  }
  return null;
}

export function triage(msg: NormalizedMessage, match: ClientMatch, ctx: TriageContext): TriageResult {
  const local = msg.fromEmail.split('@')[0] ?? '';

  // An explicit block beats everything, including a client.
  if (ctx.blockedSenders.has(msg.fromEmail)) {
    return { branch: 'bulk', classify: false, reason: 'filtered', filterReason: 'blocked_sender', unmatchedClient: false };
  }
  if (ctx.blockedDomains.has(msg.fromDomain)) {
    return { branch: 'bulk', classify: false, reason: 'filtered', filterReason: 'blocked_domain', unmatchedClient: false };
  }

  // --- 1. Client mail.
  if (ctx.isClient) {
    const automated = automatedSignal(msg);
    if (automated) {
      return { branch: 'client', classify: false, reason: 'filtered', filterReason: automated, unmatchedClient: false };
    }
    // Gmail's category labels are deliberately NOT consulted here.
    return { branch: 'client', classify: true, reason: null, filterReason: null, unmatchedClient: false };
  }

  // --- 2. Spam, promotional, automated.
  const bulk = bulkReason(msg, local);
  if (bulk) {
    return { branch: 'bulk', classify: false, reason: 'filtered', filterReason: bulk, unmatchedClient: false };
  }

  // --- 3. A real person who is not a known client.
  if (ctx.contacts.hasContacted(msg.fromEmail)) {
    return { branch: 'known_contact', classify: true, reason: null, filterReason: null, unmatchedClient: true };
  }

  // Never written to them, and they are not a client: cold.
  return { branch: 'cold', classify: false, reason: 'filtered', filterReason: 'no_prior_contact', unmatchedClient: true };
}

function bulkReason(msg: NormalizedMessage, local: string): string | null {
  const h = msg.headers;
  const precedence = (h.precedence ?? '').toLowerCase();

  const label = msg.labels.find((l) => BULK_LABELS.has(l));
  if (label) return `gmail_label:${label}`;

  if ('list-unsubscribe' in h || 'list-id' in h) return 'bulk';
  if (precedence === 'bulk' || precedence === 'list') return 'bulk';

  const automated = automatedSignal(msg);
  if (automated) return automated;

  if (AUTOMATED_LOCAL.test(local)) return 'automated_sender';
  if (isRoleAddress(local)) return 'role_address';
  if (msg.hasCalendarPart) return 'calendar';

  return null;
}
