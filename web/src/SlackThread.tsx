import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api, type SlackThread as SlackThreadView } from './api';
import { reactionLabel } from './emoji';
import { renderSlackMarkdown, type SlackUsers } from './slackMarkdown';
import { useDrawerWidth } from './useDrawerWidth';

type Msg = SlackThreadView['messages'][number];

/**
 * A channel, read the way Slack shows one.
 *
 * Top to bottom, newest at the bottom, thread replies hanging off the message
 * they answer, consecutive messages from one person collapsed under a single
 * name, and a date between days. The first cut rendered a flat list of
 * name-tag-timestamp headers with the raw wire text underneath; it was
 * legible, but nobody could tell at a glance who was talking to whom, and
 * every `_word_` and `<@U0359TLU8HM>` had to be decoded by the reader.
 */
interface Node { message: Msg; replies: Msg[] }

function buildTree(messages: Msg[]): Node[] {
  const nodes = new Map<string, Node>();
  const order: string[] = [];

  for (const m of messages) {
    if (m.threadOf) continue;
    nodes.set(m.ts, { message: m, replies: [] });
    order.push(m.ts);
  }
  for (const m of messages) {
    if (!m.threadOf) continue;
    const parent = nodes.get(m.threadOf);
    if (parent) { parent.replies.push(m); continue; }
    // A reply whose parent fell outside the window still has to appear, or
    // the answer to the question goes missing.
    nodes.set(m.ts, { message: m, replies: [] });
    order.push(m.ts);
  }
  for (const node of nodes.values()) node.replies.sort((a, b) => Number(a.ts) - Number(b.ts));
  return order.map((ts) => nodes.get(ts)!).sort((a, b) => Number(a.message.ts) - Number(b.message.ts));
}

/** Slack's own grouping: same author, same day, within five minutes. */
function sameGroup(prev: Msg | null, m: Msg): boolean {
  if (!prev || prev.authorId !== m.authorId) return false;
  if (dayKey(prev.at) !== dayKey(m.at)) return false;
  if (prev.pending !== m.pending) return false;
  return new Date(m.at).getTime() - new Date(prev.at).getTime() < 5 * 60_000;
}

const dayKey = (iso: string): string => new Date(iso).toDateString();

function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const sameYear = d.getFullYear() === today.getFullYear();
  return d.toLocaleDateString(undefined, {
    weekday: 'long', day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }),
  });
}

const clockTime = (iso: string): string =>
  new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** A stable colour per person, so the same face keeps the same tile. */
const AVATAR_HUES = [210, 340, 20, 150, 265, 45, 190, 300, 95, 0];
function avatarStyle(id: string | null, isInternal: boolean): React.CSSProperties {
  let hash = 0;
  for (const ch of id ?? 'unknown') hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = AVATAR_HUES[hash % AVATAR_HUES.length]!;
  return {
    background: `hsl(${hue} ${isInternal ? 18 : 62}% ${isInternal ? 86 : 52}%)`,
    color: isInternal ? `hsl(${hue} 40% 30%)` : '#fff',
  };
}

function initials(name: string): string {
  // Letters and digits only: "Jacque [PST]" gave the initials "J[".
  const parts = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export function SlackThread({ itemId, onClose, onChanged }: {
  itemId: number; onClose: () => void; onChanged: () => void;
}) {
  const [thread, setThread] = useState<SlackThreadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openThreads, setOpenThreads] = useState<Set<string>>(new Set());
  const { width, startResize } = useDrawerWidth();
  const logRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(() => {
    api.slackThread(itemId).then(setThread).catch((e) => setError(e.message));
  }, [itemId]);
  useEffect(load, [load]);

  const tree = useMemo(() => (thread ? buildTree(thread.messages) : []), [thread]);
  const users: SlackUsers = thread?.users ?? {};

  // A thread holding something unanswered opens by itself: it is the reason
  // the channel is on the queue, and leaving it collapsed hides the work.
  useEffect(() => {
    if (!thread) return;
    const auto = new Set<string>();
    for (const m of thread.messages) if (m.pending && m.threadOf) auto.add(m.threadOf);
    if (auto.size > 0) setOpenThreads((prev) => new Set([...prev, ...auto]));
  }, [thread]);

  // Open at the newest message, the way Slack does. Once per channel: marking
  // something answered reloads the view, and yanking it back to the bottom
  // would lose the place of anyone reading from the top.
  const landedAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = logRef.current;
    if (!el || tree.length === 0 || landedAt.current === itemId) return;
    el.scrollTop = el.scrollHeight;
    landedAt.current = itemId;
  }, [tree, itemId]);

  const jumpToWaiting = (): void => {
    const el = logRef.current?.querySelector('.slack-msg.pending');
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const act = async (fn: () => Promise<unknown>, message: string): Promise<void> => {
    setBusy(true);
    try { await fn(); setNotice(message); onChanged(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const markAnswered = (ts: string): Promise<void> =>
    act(async () => { await api.slackAnswered(itemId, ts); load(); }, 'Marked answered');

  const toggleThread = (ts: string): void => setOpenThreads((prev) => {
    const next = new Set(prev);
    next.has(ts) ? next.delete(ts) : next.add(ts);
    return next;
  });

  const waiting = thread?.pendingCount ?? 0;
  let prev: Msg | null = null;
  let lastDay = '';

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer slack-drawer" style={{ width }}>
        <div className="drawer-resize" onMouseDown={startResize} title="Drag to resize" />

        <div className="drawer-head">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <h1 style={{ fontSize: 16 }}>#{thread?.channelName ?? 'Loading…'}</h1>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {thread?.clientName ?? 'Unmatched client'}
                {thread && (
                  waiting > 0
                    ? <> · <strong className="slack-waiting-count">{waiting} waiting on us</strong></>
                    : <> · nothing waiting</>
                )}
                {thread?.permalink && (
                  <> · <a href={thread.permalink} target="_blank" rel="noopener noreferrer">Open in Slack</a></>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flex: 'none' }}>
              {waiting > 0 && (
                <button className="btn small" onClick={jumpToWaiting} title="Scroll to the oldest unanswered message">
                  Jump to waiting
                </button>
              )}
              <button className="btn" onClick={onClose}>Close</button>
            </div>
          </div>
        </div>

        {notice && <div className="banner ok">{notice}</div>}
        {error && <div className="banner err">{error}</div>}

        <div className="slack-log" ref={logRef}>
          {thread == null && !error && <div className="empty">Loading…</div>}

          {thread?.purgedThroughTs && (
            // Otherwise a channel that has been running for a year looks as
            // though it started three weeks ago.
            <div className="slack-purge-note">
              Older answered messages were removed after {thread.retentionDays} days.
              The full history is in Slack.
            </div>
          )}

          {tree.map((node) => {
            const day = dayKey(node.message.at);
            const divider = day !== lastDay ? dayLabel(node.message.at) : null;
            if (divider) { lastDay = day; prev = null; }
            const grouped = sameGroup(prev, node.message);
            prev = node.message;
            const open = openThreads.has(node.message.ts);
            if (node.replies.length > 0) prev = null;

            return (
              <div key={node.message.ts} className="slack-node">
                {divider && (
                  <div className="slack-day"><span>{divider}</span></div>
                )}
                <SlackMessage
                  m={node.message}
                  users={users}
                  grouped={grouped}
                  onAnswered={markAnswered}
                  busy={busy}
                />
                {node.replies.length > 0 && (
                  <div className="slack-thread">
                    <button className="slack-thread-toggle" onClick={() => toggleThread(node.message.ts)}>
                      <span className="slack-thread-faces">
                        {[...new Set(node.replies.map((r) => r.authorId))].slice(0, 3).map((id, i) => {
                          const who = node.replies.find((r) => r.authorId === id)!;
                          return (
                            <span key={i} className="slack-avatar tiny" style={avatarStyle(id, who.isInternal)}>
                              {initials(who.author)}
                            </span>
                          );
                        })}
                      </span>
                      {node.replies.length} {node.replies.length === 1 ? 'reply' : 'replies'}
                      {node.replies.some((r) => r.pending) && <span className="tag waiting">waiting</span>}
                      <span className="slack-thread-caret">{open ? 'Hide' : 'Show'}</span>
                    </button>
                    {open && (
                      <div className="slack-replies">
                        {node.replies.map((r, i) => (
                          <SlackMessage
                            key={r.ts}
                            m={r}
                            users={users}
                            grouped={sameGroup(node.replies[i - 1] ?? null, r)}
                            reply
                            onAnswered={markAnswered}
                            busy={busy}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {thread && tree.length === 0 && <div className="empty">No messages stored for this channel.</div>}
        </div>

        <div className="drawer-actions">
          {/* No composer: replies are written in Slack, where the threading,
              formatting and files are. This panel is for seeing what is
              unanswered and recording that it has been dealt with. */}
          {waiting > 0 && (
            <button
              className="btn primary"
              disabled={busy}
              title="Clear everything waiting in this channel"
              onClick={() => act(async () => { await api.slackMarkRead(itemId); load(); }, 'Marked as read')}
            >
              Mark all {waiting} answered
            </button>
          )}
          {thread?.permalink && (
            <a className="btn" href={thread.permalink} target="_blank" rel="noopener noreferrer">
              Open in Slack
            </a>
          )}
        </div>
      </aside>
    </>
  );
}

function SlackMessage({ m, users, grouped, reply = false, onAnswered, busy }: {
  m: Msg; users: SlackUsers; grouped: boolean; reply?: boolean;
  onAnswered: (ts: string) => void; busy: boolean;
}) {
  const classes = [
    'slack-msg',
    m.isInternal ? 'internal' : 'external',
    m.pending ? 'pending' : '',
    m.deleted ? 'deleted' : '',
    reply ? 'is-reply' : '',
    grouped ? 'grouped' : '',
  ].filter(Boolean).join(' ');

  return (
    <div className={classes}>
      <div className="slack-avatar-col">
        {grouped
          ? <span className="slack-hover-time">{clockTime(m.at)}</span>
          : (
            <span className="slack-avatar" style={avatarStyle(m.authorId, m.isInternal)} title={m.author}>
              {initials(m.author)}
            </span>
          )}
      </div>

      <div className="slack-msg-main">
        {!grouped && (
          <div className="slack-msg-head">
            <strong className="slack-author">{m.author}</strong>
            {/* Only our own side is labelled. In a channel of the client's
                every single person is "client", and a tag on every line
                stopped carrying information. */}
            {m.isInternal && <span className="tag us">us</span>}
            <span className="slack-time">{clockTime(m.at)}</span>
            {m.pending && <span className="tag waiting">waiting</span>}
          </div>
        )}
        <div className="slack-msg-body">
          {m.deleted
            ? <em className="muted">This message was deleted.</em>
            : renderSlackMarkdown(m.text, users)}
          {m.edited && !m.deleted && <span className="slack-edited"> (edited)</span>}
        </div>
        {Object.keys(m.reactions).length > 0 && (
          <div className="slack-reactions">
            {Object.entries(m.reactions).map(([name, who]) => (
              <span key={name} className="slack-reaction" title={`:${name}:`}>
                {reactionLabel(name)} <span className="slack-reaction-n">{who.length}</span>
              </span>
            ))}
          </div>
        )}
      </div>

      {m.pending && (
        <button
          className="btn small slack-answer-btn"
          disabled={busy}
          onClick={() => onAnswered(m.ts)}
          title="This one has been dealt with"
        >
          Mark answered
        </button>
      )}
    </div>
  );
}
