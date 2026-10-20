import { config } from '../lib/config.js';

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

export interface ClientGroup {
  /** ts of the first client message in the run; the item's identity. */
  groupTs: string;
  messages: StoredSlackMessage[];
  authorId: string | null;
}

const TICK_REACTIONS = new Set(['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check', 'heavy_tick_mark']);

/**
 * Splits a channel's top-level messages into client-message groups.
 *
 * A group is a run of consecutive client messages from the same person with
 * no internal message in between and no more than SLACK_GROUP_GAP_MINUTES
 * between them. People type in bursts; three lines in ten seconds is one
 * thing to answer, not three.
 */
export function groupClientMessages(messages: StoredSlackMessage[]): ClientGroup[] {
  const gapMs = config.slack.groupGapMinutes * 60_000;
  const groups: ClientGroup[] = [];
  let current: ClientGroup | null = null;

  for (const m of messages) {
    if (m.deleted) continue;
    if (m.isInternal) { current = null; continue; }

    const sameAuthor = current != null && current.authorId === m.userId;
    const last = current?.messages[current.messages.length - 1];
    const withinGap = last != null && m.postedAt.getTime() - last.postedAt.getTime() <= gapMs;

    if (current && sameAuthor && withinGap) {
      current.messages.push(m);
    } else {
      current = { groupTs: m.ts, messages: [m], authorId: m.userId };
      groups.push(current);
    }
  }
  return groups;
}

export type ResolutionReason = 'thread_reply' | 'tick_reaction' | 'only_pending' | null;

export interface Resolution {
  replied: boolean;
  reason: ResolutionReason;
}

/**
 * Deterministic reply rules, in order. Returns null reason when nothing here
 * settles it and the question has to go to the LLM window.
 *
 * `internalAfter` is every internal top-level message later than the group.
 */
export function resolveGroup(opts: {
  group: ClientGroup;
  threadReplies: StoredSlackMessage[];
  internalUserIds: Set<string>;
  internalTopLevelAfter: StoredSlackMessage[];
  pendingGroupCount: number;
}): Resolution {
  const { group, threadReplies, internalUserIds, internalTopLevelAfter, pendingGroupCount } = opts;

  // 1. An internal reply inside the group's thread answers it, whatever else
  //    is happening in the channel.
  const groupTsSet = new Set(group.messages.map((m) => m.ts));
  const answeredInThread = threadReplies.some(
    (r) => r.isInternal && !r.deleted && (groupTsSet.has(r.threadTs ?? '') || Number(r.ts) > Number(group.groupTs)),
  );
  if (answeredInThread) return { replied: true, reason: 'thread_reply' };

  // 2. A tick from one of us is an answer: it is how people close a request
  //    without typing.
  for (const m of group.messages) {
    for (const [name, users] of Object.entries(m.reactions)) {
      if (!TICK_REACTIONS.has(name)) continue;
      if (users.some((u) => internalUserIds.has(u))) return { replied: true, reason: 'tick_reaction' };
    }
  }

  // 5. Internal chatter that only @mentions colleagues answers nothing, so it
  //    does not count towards rule 4.
  const answering = internalTopLevelAfter.filter((m) => !mentionsOnlyInternal(m.text, internalUserIds));

  // 4. One pending group and an internal message after it: that message is
  //    the answer. With several pending groups it is ambiguous -- which one
  //    did they answer? -- and that is the LLM window's job.
  if (answering.length > 0) {
    if (pendingGroupCount <= 1) return { replied: true, reason: 'only_pending' };
    return { replied: false, reason: null };
  }

  return { replied: false, reason: 'only_pending' };
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

/** Short acknowledgements and bare emoji need no reply (CLAUDE.md override 3). */
export function isAcknowledgement(text: string): boolean {
  const stripped = text
    .replace(/<@[A-Z0-9_]+(?:\|[^>]*)?>/g, ' ')
    .replace(/:[a-z0-9_+-]+:/g, ' ')
    .replace(/[\p{Extended_Pictographic}‍️]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Nothing but emoji or a mention.
  if (stripped === '') return true;
  if (stripped.length >= 200 || stripped.includes('?')) return false;

  const ASKS = /\b(can you|could you|please|need|when|send|share|confirm|update|any chance|would you)\b/i;
  if (ASKS.test(stripped)) return false;

  // One acknowledgement rarely arrives alone: "Perfect, thanks" and "ok got
  // it, cheers" are the same message. Strip every known phrase in turn and
  // see whether anything of substance is left.
  let rest = stripped.toLowerCase();
  let changed = true;
  while (changed) {
    changed = false;
    for (const phrase of ACK_PHRASES) {
      const re = new RegExp(`^${phrase}\\b[\\s.,!—–-]*`, 'i');
      if (re.test(rest)) {
        rest = rest.replace(re, '');
        changed = true;
      }
    }
  }
  return rest.trim() === '';
}

/** Longest first, so "thank you" is not consumed as "thank". */
const ACK_PHRASES = [
  'thanks a lot', 'thanks so much', 'thank you so much', 'thank you', 'thankyou',
  'sounds good', 'sounds great', 'looks good', 'will do', 'got it', 'much appreciated',
  'appreciate it', 'no worries', 'all good', 'makes sense', 'understood', 'received',
  'thanks', 'thanx', 'ty', 'tysm', 'cheers', 'noted', 'gotcha', 'perfect', 'great',
  'awesome', 'amazing', 'brilliant', 'excellent', 'wonderful', 'super', 'lovely',
  'nice', 'cool', 'okay', 'ok', 'k', 'sure', 'yes', 'yep', 'yup', 'yeah', 'done',
  'fine', 'alright', 'right', 'good',
];
