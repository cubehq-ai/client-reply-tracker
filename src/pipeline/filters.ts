import type { NormalizedMessage } from './normalize.js';

export interface FilterVerdict {
  /** True when the message should be auto_ignored. */
  filtered: boolean;
  reason: string | null;
  /** True for anything machine-generated; kept even when not filtered. */
  isAuto: boolean;
  isBounce: boolean;
}

const BULK_LABELS = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS', 'SPAM']);

const NOREPLY_LOCAL = /^(no[-._]?reply|do[-._]?not[-._]?reply|notifications?|notify|mailer[-._]?daemon|postmaster|bounces?|automated|alerts?|donotreply)([-._+].*)?$/i;

const AUTOREPLY_SUBJECT = /\b(out of (the )?office|automatic reply|auto[- ]?reply|autoreply|abwesenheit|vacation reply|on leave|away from (my )?(desk|email))\b/i;

const CALENDAR_SUBJECT = /^(accepted|declined|tentative|cancelled|canceled|invitation|updated invitation|new time proposed):/i;

const BOUNCE_SUBJECT = /\b(delivery status notification|undeliverable|returned mail|mail delivery (failed|subsystem)|delivery has failed|message not delivered)\b/i;

export interface FilterContext {
  /** True when the sender's domain or address belongs to a known client. */
  isClient: boolean;
  /** Org-level block rules: lowercase emails and domains. */
  blockedSenders: Set<string>;
  blockedDomains: Set<string>;
  /** Allow rules win over every block rule. */
  allowedSenders: Set<string>;
}

/**
 * Rule-based filtering (SPEC 4 step 3). Free, runs on everything, and is
 * language-independent because it reads headers rather than prose.
 *
 * Client exception: a known client's mail skips the Gmail *label* rules, since
 * clients land in Updates and Promotions often enough to matter. Header rules
 * (bulk, auto-submitted, bounce) still apply to clients.
 */
export function applyFilters(msg: NormalizedMessage, ctx: FilterContext): FilterVerdict {
  const h = msg.headers;
  const local = msg.fromEmail.split('@')[0] ?? '';

  const isBounce =
    /mailer-daemon|postmaster/i.test(msg.fromEmail) ||
    BOUNCE_SUBJECT.test(msg.subject) ||
    (h['content-type'] ?? '').includes('report-type=delivery-status');

  const autoSubmitted = (h['auto-submitted'] ?? '').toLowerCase();
  const isAutoSubmitted = autoSubmitted !== '' && autoSubmitted !== 'no';
  const isAutoReply = isAutoSubmitted || 'x-autoreply' in h || 'x-autorespond' in h || AUTOREPLY_SUBJECT.test(msg.subject);
  const precedence = (h.precedence ?? '').toLowerCase();
  const isBulk = precedence === 'bulk' || precedence === 'list' || 'list-unsubscribe' in h || 'list-id' in h;
  const isCalendar = msg.hasCalendarPart || CALENDAR_SUBJECT.test(msg.subject);
  const isAuto = isBounce || isAutoReply || isBulk || isCalendar || NOREPLY_LOCAL.test(local);

  const verdict = (reason: string | null): FilterVerdict => ({ filtered: reason !== null, reason, isAuto, isBounce });

  // An explicit allow rule overrides everything below it.
  if (ctx.allowedSenders.has(msg.fromEmail)) return verdict(null);

  if (ctx.blockedSenders.has(msg.fromEmail)) return verdict('blocked_sender');
  if (ctx.blockedDomains.has(msg.fromDomain)) return verdict('blocked_domain');

  if (isBounce) return verdict('bounce');
  if (isAutoReply) return verdict('auto_reply');
  if (isCalendar) return verdict('calendar');
  if (isBulk) return verdict('bulk');
  if (NOREPLY_LOCAL.test(local)) return verdict('noreply_sender');

  // Label rules only for non-clients (SPEC 4 step 3 exception).
  if (!ctx.isClient) {
    const hit = msg.labels.find((l) => BULK_LABELS.has(l));
    if (hit) return verdict(`gmail_label:${hit}`);
  } else if (msg.labels.includes('SPAM')) {
    // Even for clients, Gmail's spam verdict is worth honouring.
    return verdict('gmail_label:SPAM');
  }

  return verdict(null);
}
