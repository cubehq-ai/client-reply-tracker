import { isAcknowledgement, mentionsOnlyInternal, type StoredSlackMessage } from './groups.js';

const TICK_REACTIONS = new Set(['white_check_mark', 'heavy_check_mark', 'ballot_box_with_check']);

export type PendingReason =
  | 'thread_reply'
  | 'tick_reaction'
  | 'internal_after'
  | 'acknowledgement'
  | 'later_acknowledgement';

export interface PendingVerdict {
  ts: string;
  pending: boolean;
  /** Why it is not pending. Null while it still is. */
  closedBy: PendingReason | null;
}

export interface PendingResult {
  verdicts: PendingVerdict[];
  /**
   * Client messages closed by rule 3 using one internal message. Two or more
   * means one reply was credited with answering several questions, which is
   * exactly the case the model is asked to check.
   */
  closedByInternalAfter: Map<string, string[]>;
}

/**
 * Decides which client messages in a channel are still waiting on us.
 *
 * Per message rather than per group: a channel is one conversation, and what
 * matters is whether anything in it is unanswered.
 */
export function computePending(messages: StoredSlackMessage[], internalUserIds: Set<string>): PendingResult {
  const live = messages.filter((m) => !m.deleted);
  const clientMessages = live.filter((m) => !m.isInternal);
  const internalMessages = live.filter((m) => m.isInternal);
  const verdicts: PendingVerdict[] = [];
  const closedByInternalAfter = new Map<string, string[]>();

  // Rule 5 first: an acknowledgement from a client clears everything they
  // were waiting on. They would not be thanking us otherwise.
  const ackTimeByAuthor = new Map<string, number>();
  for (const m of clientMessages) {
    if (!isAcknowledgement(m.text)) continue;
    const at = Number(m.ts);
    const prev = ackTimeByAuthor.get(m.userId ?? '');
    if (prev == null || at > prev) ackTimeByAuthor.set(m.userId ?? '', at);
  }

  for (const m of clientMessages) {
    const ts = Number(m.ts);
    const threadKey = m.threadTs ?? m.ts;

    // 1. An internal reply in its thread, after it.
    const answeredInThread = internalMessages.some(
      (i) => (i.threadTs ?? i.ts) === threadKey && Number(i.ts) > ts,
    );
    if (answeredInThread) { verdicts.push({ ts: m.ts, pending: false, closedBy: 'thread_reply' }); continue; }

    // 2. A tick from one of us.
    const ticked = Object.entries(m.reactions).some(
      ([name, users]) => TICK_REACTIONS.has(name) && users.some((u) => internalUserIds.has(u)),
    );
    if (ticked) { verdicts.push({ ts: m.ts, pending: false, closedBy: 'tick_reaction' }); continue; }

    // 4. It asks nothing of us.
    if (isAcknowledgement(m.text)) {
      verdicts.push({ ts: m.ts, pending: false, closedBy: 'acknowledgement' });
      continue;
    }

    // 5. The same person acknowledged later.
    const ack = ackTimeByAuthor.get(m.userId ?? '');
    if (ack != null && ack > ts) {
      verdicts.push({ ts: m.ts, pending: false, closedBy: 'later_acknowledgement' });
      continue;
    }

    // 3. Top-level only: an internal top-level message after it that is not
    //    just us talking among ourselves. A question inside a thread is NOT
    //    answered by unrelated channel chatter, which is the whole point of
    //    someone having put it in a thread.
    const isTopLevel = m.threadTs == null || m.threadTs === m.ts;
    if (isTopLevel) {
      const answering = internalMessages.find(
        (i) => (i.threadTs == null || i.threadTs === i.ts)
          && Number(i.ts) > ts
          && !mentionsOnlyInternal(i.text, internalUserIds),
      );
      if (answering) {
        verdicts.push({ ts: m.ts, pending: false, closedBy: 'internal_after' });
        const list = closedByInternalAfter.get(answering.ts) ?? [];
        list.push(m.ts);
        closedByInternalAfter.set(answering.ts, list);
        continue;
      }
    }

    verdicts.push({ ts: m.ts, pending: true, closedBy: null });
  }

  return { verdicts, closedByInternalAfter };
}

/** Message ids that one internal message was credited with answering, 2+. */
export function ambiguousClosures(result: PendingResult): string[] {
  const out: string[] = [];
  for (const closed of result.closedByInternalAfter.values()) {
    if (closed.length >= 2) out.push(...closed);
  }
  return out;
}
