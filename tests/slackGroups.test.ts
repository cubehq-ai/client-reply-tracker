import { describe, expect, it } from 'vitest';
import {
  groupClientMessages, isAcknowledgement, mentionsOnlyInternal, resolveGroup,
  type StoredSlackMessage,
} from '../src/slack/groups.js';

const T0 = new Date('2026-10-20T09:00:00Z').getTime();
const m = (p: Partial<StoredSlackMessage> & { ts: string; minute: number }): StoredSlackMessage => ({
  ts: p.ts,
  threadTs: p.threadTs ?? null,
  userId: p.userId ?? 'U_CLIENT',
  isInternal: p.isInternal ?? false,
  text: p.text ?? 'hello',
  reactions: p.reactions ?? {},
  deleted: p.deleted ?? false,
  postedAt: new Date(T0 + p.minute * 60_000),
});

const INTERNAL = new Set(['U_US', 'U_COLLEAGUE']);

describe('grouping client messages', () => {
  it('folds a burst from one person into a single group', () => {
    const groups = groupClientMessages([
      m({ ts: '1', minute: 0, text: 'hi' }),
      m({ ts: '2', minute: 1, text: 'one more thing' }),
      m({ ts: '3', minute: 2, text: 'and this' }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.groupTs).toBe('1');
    expect(groups[0]!.messages).toHaveLength(3);
  });

  it('starts a new group after an internal message', () => {
    const groups = groupClientMessages([
      m({ ts: '1', minute: 0 }),
      m({ ts: '2', minute: 1, isInternal: true, userId: 'U_US' }),
      m({ ts: '3', minute: 2 }),
    ]);
    expect(groups.map((g) => g.groupTs)).toEqual(['1', '3']);
  });

  it('starts a new group when the gap is too long', () => {
    const groups = groupClientMessages([m({ ts: '1', minute: 0 }), m({ ts: '2', minute: 40 })]);
    expect(groups).toHaveLength(2);
  });

  it('starts a new group for a different person', () => {
    const groups = groupClientMessages([
      m({ ts: '1', minute: 0, userId: 'U_CLIENT' }),
      m({ ts: '2', minute: 1, userId: 'U_CLIENT_2' }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it('ignores deleted messages', () => {
    expect(groupClientMessages([m({ ts: '1', minute: 0, deleted: true })])).toHaveLength(0);
  });
});

describe('deterministic resolution', () => {
  const group = { groupTs: '1', authorId: 'U_CLIENT', messages: [m({ ts: '1', minute: 0 })] };

  it('a thread reply from us closes it', () => {
    const r = resolveGroup({
      group,
      threadReplies: [m({ ts: '1.5', minute: 1, threadTs: '1', isInternal: true, userId: 'U_US' })],
      internalUserIds: INTERNAL,
      internalTopLevelAfter: [],
      pendingGroupCount: 3,
    });
    expect(r).toEqual({ replied: true, reason: 'thread_reply' });
  });

  it('a tick from us closes it', () => {
    const r = resolveGroup({
      group: { ...group, messages: [m({ ts: '1', minute: 0, reactions: { white_check_mark: ['U_US'] } })] },
      threadReplies: [], internalUserIds: INTERNAL, internalTopLevelAfter: [], pendingGroupCount: 3,
    });
    expect(r).toEqual({ replied: true, reason: 'tick_reaction' });
  });

  it('a tick from the client does not close it', () => {
    const r = resolveGroup({
      group: { ...group, messages: [m({ ts: '1', minute: 0, reactions: { white_check_mark: ['U_CLIENT'] } })] },
      threadReplies: [], internalUserIds: INTERNAL, internalTopLevelAfter: [], pendingGroupCount: 1,
    });
    expect(r.replied).toBe(false);
  });

  it('closes the only pending group when we post after it', () => {
    const r = resolveGroup({
      group, threadReplies: [], internalUserIds: INTERNAL,
      internalTopLevelAfter: [m({ ts: '2', minute: 5, isInternal: true, userId: 'U_US', text: 'on it' })],
      pendingGroupCount: 1,
    });
    expect(r).toEqual({ replied: true, reason: 'only_pending' });
  });

  it('defers to the LLM window when several groups are pending', () => {
    const r = resolveGroup({
      group, threadReplies: [], internalUserIds: INTERNAL,
      internalTopLevelAfter: [m({ ts: '2', minute: 5, isInternal: true, userId: 'U_US', text: 'on it' })],
      pendingGroupCount: 2,
    });
    expect(r).toEqual({ replied: false, reason: null });
  });

  it('internal chatter mentioning only a colleague closes nothing', () => {
    const r = resolveGroup({
      group, threadReplies: [], internalUserIds: INTERNAL,
      internalTopLevelAfter: [m({ ts: '2', minute: 5, isInternal: true, userId: 'U_US', text: '<@U_COLLEAGUE> can you take this?' })],
      pendingGroupCount: 1,
    });
    expect(r.replied).toBe(false);
  });
});

describe('mention reading', () => {
  it('sees an all-internal mention as chatter', () => {
    expect(mentionsOnlyInternal('<@U_COLLEAGUE> please look', INTERNAL)).toBe(true);
  });
  it('does not treat a mention of the client as chatter', () => {
    expect(mentionsOnlyInternal('<@U_CLIENT> here you go', INTERNAL)).toBe(false);
  });
  it('plain text is not chatter', () => {
    expect(mentionsOnlyInternal('looking into it', INTERNAL)).toBe(false);
  });
});

describe('acknowledgements', () => {
  it.each(['thanks', 'Thanks!', 'thank you', 'noted', 'got it', 'ok', 'Perfect, thanks', '👍', ':+1:', 'will do'])(
    'treats %j as needing no reply', (text) => {
      expect(isAcknowledgement(text)).toBe(true);
    });

  it.each([
    'thanks, can you also send the invoice?',
    'thanks — when will this go live?',
    'got it, please update the deck',
    'ok but we need the report today',
  ])('does not swallow a request wrapped in thanks: %j', (text) => {
    expect(isAcknowledgement(text)).toBe(false);
  });
});
