/** One stored Slack message, as the pending rules read it. */
export interface StoredSlackMessage {
  ts: string;
  threadTs: string | null;
  userId: string | null;
  isInternal: boolean;
  text: string;
  reactions: Record<string, string[]>;
  deleted: boolean;
  postedAt: Date;
}

/**
 * True when every @mention in the text is an internal user and there is at
 * least one. "@priya can you take this?" is one of us talking to another.
 */
export function mentionsOnlyInternal(text: string, internalUserIds: Set<string>): boolean {
  const mentions = [...text.matchAll(/<@([A-Z0-9_]+)(?:\|[^>]*)?>/g)].map((m) => m[1]!);
  if (mentions.length === 0) return false;
  return mentions.every((id) => internalUserIds.has(id));
}

/**
 * Whether a client message asks nothing of us.
 *
 * Real thanks are not tidy: "Thank you as always @Shireen!" and "this is
 * great, thank you! much appreciated!!" are the same message as "thanks", but
 * a rule that required the whole text to be a chain of known phrases left
 * both of them sitting in the queue. So: short, no question, nothing that
 * reads as a request, and a word of thanks somewhere in it.
 */
export function isAcknowledgement(text: string): boolean {
  const stripped = text
    .replace(/<@[A-Z0-9_]+(?:\|[^>]*)?>/g, ' ')
    .replace(/<[#!][^>]*>/g, ' ')
    .replace(/:[a-z0-9_+-]+:/g, ' ')
    .replace(/[\p{Extended_Pictographic}\u200d\ufe0f]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Nothing but emoji, or nothing but a mention.
  if (stripped === '') return true;
  if (stripped.length >= 200) return false;
  if (stripped.includes('?')) return false;
  if (ASKS.test(stripped)) return false;

  return ACK_MARKER.test(stripped) || isPhraseChain(stripped);
}

/** Anything that means they still want something, whatever else they said. */
const ASKS = /\b(can you|could you|can we|could we|please|need|needs|when|send|share|confirm|update|let me know|any chance|would you|kindly|waiting|follow up|chase)\b/i;

/** A word of thanks or assent somewhere in the message. */
const ACK_MARKER = /\b(thanks|thank you|thankyou|thx|tysm|appreciated?|appreciate it|noted|got it|gotcha|received|understood|will do|sounds good|looks good|no worries|all good|makes sense|perfect|great|awesome|amazing|brilliant|excellent|wonderful|cheers)\b/i;

/** The terse ones, which carry no marker word at all: "ok", "yes", "done". */
function isPhraseChain(text: string): boolean {
  let rest = text.toLowerCase();
  let changed = true;
  while (changed) {
    changed = false;
    for (const phrase of ACK_PHRASES) {
      const re = new RegExp(`^${phrase}\\b[\\s.,!—–-]*`, 'i');
      if (re.test(rest)) { rest = rest.replace(re, ''); changed = true; }
    }
  }
  return rest.trim() === '';
}

/** Longest first, so "thank you" is not consumed as "thank". */
const ACK_PHRASES = [
  'sounds good', 'looks good', 'will do', 'got it', 'all good', 'no worries',
  'makes sense', 'understood', 'received', 'okay', 'ok', 'k', 'sure', 'yes',
  'yep', 'yup', 'yeah', 'done', 'fine', 'alright', 'right', 'good', 'noted',
];
