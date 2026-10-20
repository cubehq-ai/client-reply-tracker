import { describe, expect, it } from 'vitest';
import { isAcknowledgement, mentionsOnlyInternal, type StoredSlackMessage } from '../src/slack/groups.js';
import { ambiguousClosures, computePending } from '../src/slack/pending.js';

const T0 = new Date('2026-10-20T09:00:00Z').getTime();
const m = (p: Partial<StoredSlackMessage> & { ts: string; minute: number }): StoredSlackMessage => ({
  ts: p.ts,
  threadTs: p.threadTs ?? null,
  userId: p.userId ?? 'U_CLIENT',
  isInternal: p.isInternal ?? false,
  text: p.text ?? 'Can you check this?',
  reactions: p.reactions ?? {},
  deleted: p.deleted ?? false,
  postedAt: new Date(T0 + p.minute * 60_000),
});
const INTERNAL = new Set(['U_US', 'U_COLLEAGUE']);
const us = (ts: string, minute: number, text = 'on it', extra: Partial<StoredSlackMessage> = {}) =>
  m({ ts, minute, isInternal: true, userId: 'U_US', text, ...extra });

const pendingTs = (messages: StoredSlackMessage[]): string[] =>
  computePending(messages, INTERNAL).verdicts.filter((v) => v.pending).map((v) => v.ts);

describe('which client messages are still waiting', () => {
  it('an unanswered question is pending', () => {
    expect(pendingTs([m({ ts: '1', minute: 0 })])).toEqual(['1']);
  });

  it('a thread reply from us closes it', () => {
    expect(pendingTs([m({ ts: '1', minute: 0 }), us('2', 5, 'looking', { threadTs: '1' })])).toEqual([]);
  });

  it('a tick from us closes it, a tick from the client does not', () => {
    expect(pendingTs([m({ ts: '1', minute: 0, reactions: { white_check_mark: ['U_US'] } })])).toEqual([]);
    expect(pendingTs([m({ ts: '1', minute: 0, reactions: { white_check_mark: ['U_CLIENT'] } })])).toEqual(['1']);
  });

  it('a top-level reply from us closes a top-level question', () => {
    expect(pendingTs([m({ ts: '1', minute: 0 }), us('2', 5)])).toEqual([]);
  });

  it('chatter that only @mentions a colleague closes nothing', () => {
    expect(pendingTs([m({ ts: '1', minute: 0 }), us('2', 5, '<@U_COLLEAGUE> can you take this?')])).toEqual(['1']);
  });

  it('leaves a question asked inside a thread pending when only the channel moved on', () => {
    // Someone put it in a thread precisely so it would not be answered by
    // whatever else is going on in the channel.
    const messages = [
      m({ ts: '1', minute: 0, text: 'parent' }),
      m({ ts: '2', minute: 1, threadTs: '1', text: 'and can you also check the invoice?' }),
      us('3', 5, 'replying about something else entirely'),
    ];
    expect(pendingTs(messages)).toContain('2');
  });

  it('an acknowledgement needs no reply, and clears what that person was waiting on', () => {
    const messages = [
      m({ ts: '1', minute: 0, text: 'Can you publish the guide?' }),
      m({ ts: '2', minute: 30, text: 'thanks 👍' }),
    ];
    expect(pendingTs(messages)).toEqual([]);
  });

  it('does not let one person’s thanks clear another person’s question', () => {
    const messages = [
      m({ ts: '1', minute: 0, userId: 'U_OTHER', text: 'Could you send the report?' }),
      m({ ts: '2', minute: 30, userId: 'U_CLIENT', text: 'thanks!' }),
    ];
    expect(pendingTs(messages)).toEqual(['1']);
  });

  it('ignores deleted messages', () => {
    expect(pendingTs([m({ ts: '1', minute: 0, deleted: true })])).toEqual([]);
  });
});

describe('the ambiguous case', () => {
  it('flags one reply credited with answering two questions', () => {
    const result = computePending([
      m({ ts: '1', minute: 0, text: 'Can you send the invoice?' }),
      m({ ts: '2', minute: 30, text: 'And when does the campaign start?' }),
      us('3', 40, 'Invoice is out; campaign starts Monday'),
    ], INTERNAL);
    expect(ambiguousClosures(result).sort()).toEqual(['1', '2']);
  });

  it('does not flag one reply to one question', () => {
    const result = computePending([m({ ts: '1', minute: 0 }), us('2', 5)], INTERNAL);
    expect(ambiguousClosures(result)).toEqual([]);
  });
});

describe('mentions and acknowledgements', () => {
  it('reads an all-internal mention as chatter', () => {
    expect(mentionsOnlyInternal('<@U_COLLEAGUE> please look', INTERNAL)).toBe(true);
    expect(mentionsOnlyInternal('<@U_CLIENT> here you go', INTERNAL)).toBe(false);
    expect(mentionsOnlyInternal('looking into it', INTERNAL)).toBe(false);
  });

  it.each(['thanks', 'Thanks!', 'noted', 'got it', 'Perfect, thanks', '👍', 'will do'])(
    'treats %j as needing no reply', (t) => expect(isAcknowledgement(t)).toBe(true));

  it.each(['thanks, can you also send the invoice?', 'ok but we need the report today'])(
    'does not swallow a request wrapped in thanks: %j', (t) => expect(isAcknowledgement(t)).toBe(false));
});

describe('acknowledgements as people actually write them', () => {
  // Each of these sat in the real queue because the rule demanded the whole
  // message be a chain of known phrases.
  it.each([
    'Thank you as always <@U0A4P2NM5FU>!',
    'this is great, thank you! much appreciated!!',
    'Thank you <@U0A4P2NM5FU> and <@U0359TLU8HM>!',
    'perfect, that works for us',
    'noted with thanks',
  ])('treats %j as needing no reply', (t) => expect(isAcknowledgement(t)).toBe(true));

  it.each([
    'Thanks! Could you also check the invoice?',
    'thank you — please update the deck when you can',
    'Hi, just wanted to confirm if we can also mark the ticket done',
    'thanks, we still need the report today',
  ])('still sees the request inside %j', (t) => expect(isAcknowledgement(t)).toBe(false));
});
