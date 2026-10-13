import type { RawMessage } from '../gmail/types.js';

export interface NormalizedMessage {
  gmailMessageId: string;
  gmailThreadId: string;
  mailbox: string;
  labels: string[];
  rfcMessageId: string;
  inReplyTo: string | null;
  references: string[];
  fromEmail: string;
  fromDomain: string;
  fromName: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  normalizedSubject: string;
  internalDate: Date;
  snippet: string;
  bodyText: string;
  /** Body with quoted history and signature removed, for classification. */
  cleanedBody: string;
  headers: Record<string, string>;
  hasCalendarPart: boolean;
  isDraft: boolean;
  attachments: { filename: string; mimeType: string; size: number }[];
}

/** Pulls bare addresses out of a header value such as `"A B" <a@b.c>, d@e.f`. */
export function parseAddressList(value: string | undefined): string[] {
  if (!value) return [];
  const out: string[] = [];
  // Split on commas that are not inside quotes or angle brackets.
  for (const part of value.split(/,(?![^<]*>)/)) {
    const email = parseAddress(part);
    if (email) out.push(email);
  }
  return [...new Set(out)];
}

export function parseAddress(value: string | undefined): string {
  if (!value) return '';
  const angle = /<([^>]+)>/.exec(value);
  const raw = (angle?.[1] ?? value).trim().replace(/^["']|["']$/g, '');
  const match = /[^\s<>,;:"]+@[^\s<>,;:"]+/.exec(raw);
  return (match?.[0] ?? '').toLowerCase();
}

export function parseDisplayName(value: string | undefined): string {
  if (!value) return '';
  const idx = value.indexOf('<');
  if (idx <= 0) return '';
  return value.slice(0, idx).trim().replace(/^["']|["']$/g, '');
}

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).toLowerCase();
}

/** Strips every Re:/Fwd: prefix and collapses whitespace, for subject fallback matching. */
export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|fw|fwd|aw|sv|vs|antw)\s*(\[\d+\])?\s*:\s*)+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** Splits a References header into individual angle-bracketed ids. */
export function parseReferences(value: string | undefined): string[] {
  if (!value) return [];
  const ids = value.match(/<[^>]+>/g) ?? [];
  return [...new Set(ids.map((s) => s.trim()))];
}

const QUOTE_MARKERS = [
  /^On .+ wrote:\s*$/i,
  /^Begin forwarded message:/i,
  /^-{3,}\s*Forwarded message\s*-{3,}/i,
  /^-{2,}\s*Original Message\s*-{2,}$/i,
  /^_{5,}$/,
  /^From:\s.+$/i,
  /^Sent from my \w+/i,
  /^Get Outlook for \w+/i,
];
const SIGNATURE_MARKER = /^--\s*$/;

/**
 * Removes quoted history and the trailing signature so the classifier sees only
 * what the sender actually wrote this time (SPEC 4 step 1).
 */
export function cleanBody(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (SIGNATURE_MARKER.test(trimmed)) break;
    if (QUOTE_MARKERS.some((re) => re.test(trimmed))) break;
    if (trimmed.startsWith('>')) continue;
    kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function normalize(raw: RawMessage, mailbox: string): NormalizedMessage {
  const h = raw.headers;
  const fromHeader = h.from ?? '';
  const fromEmail = parseAddress(fromHeader);
  const subject = h.subject ?? '';
  const body = raw.bodyText ?? raw.snippet ?? '';
  // Gmail can omit Message-ID on odd messages; synthesise a stable one so the
  // dedupe key is never empty.
  const rfcMessageId = (h['message-id'] ?? '').trim() || `<gmail-${raw.id}@synthesized.local>`;

  return {
    gmailMessageId: raw.id,
    gmailThreadId: raw.threadId,
    mailbox: mailbox.toLowerCase(),
    labels: raw.labelIds ?? [],
    rfcMessageId,
    inReplyTo: parseReferences(h['in-reply-to'])[0] ?? null,
    references: parseReferences(h.references),
    fromEmail,
    fromDomain: domainOf(fromEmail),
    fromName: parseDisplayName(fromHeader),
    to: parseAddressList(h.to),
    cc: parseAddressList(h.cc),
    // Present only on our own sent copies; servers strip it in transit.
    bcc: parseAddressList(h.bcc),
    subject,
    normalizedSubject: normalizeSubject(subject),
    internalDate: new Date(raw.internalDateMs),
    snippet: raw.snippet ?? '',
    bodyText: body.slice(0, 4000),
    cleanedBody: cleanBody(body).slice(0, 4000),
    headers: h,
    hasCalendarPart: raw.hasCalendarPart ?? false,
    isDraft: raw.isDraft ?? (raw.labelIds ?? []).includes('DRAFT'),
    attachments: raw.attachments ?? [],
  };
}

/**
 * All RFC ids this message belongs to. Any overlap with an existing
 * conversation means the same global thread, regardless of mailbox (SPEC 2).
 */
export function threadIdentifiers(msg: NormalizedMessage): string[] {
  const ids = [msg.rfcMessageId, ...msg.references];
  if (msg.inReplyTo) ids.push(msg.inReplyTo);
  return [...new Set(ids.filter(Boolean))];
}

/**
 * Fallback conversation key when a message carries no References chain:
 * normalized subject plus the participant set (SPEC 4 step 1).
 */
export function fallbackConversationKey(msg: NormalizedMessage, orgDomains: Set<string>): string {
  const participants = [msg.fromEmail, ...msg.to, ...msg.cc]
    .filter((e) => e && !orgDomains.has(domainOf(e)))
    .sort();
  return `subj:${msg.normalizedSubject}|ext:${participants.join(',')}`;
}
