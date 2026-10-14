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
  if (msg.hasCalendarPart) return 'calendar';

  return null;
}
