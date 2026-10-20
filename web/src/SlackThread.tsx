import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, timeAgo, type SlackThread as SlackThreadView } from './api';
import { renderEmoji, reactionLabel } from './emoji';
import { useDrawerWidth } from './useDrawerWidth';

type Msg = SlackThreadView['messages'][number];

/**
 * A channel reads top to bottom, with thread replies hanging off the message
 * they answer -- which is the whole point of a thread, and was unreadable as
 * a flat list: three people answering three different questions looked like
 * one conversation.
 */
interface Node { message: Msg; replies: Msg[] }

function buildTree(messages: Msg[]): Node[] {
  const byTs = new Map(messages.map((m) => [m.ts, m]));
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
    // A reply whose parent is outside the window still has to appear, or the
    // answer to the question goes missing.
    const orphanParent = byTs.get(m.threadOf);
    const node: Node = { message: m, replies: [] };
    nodes.set(m.ts, node);
    order.push(m.ts);
    if (orphanParent) node.message = m;
  }
  return order.map((ts) => nodes.get(ts)!).sort((a, b) => Number(a.message.ts) - Number(b.message.ts));
}

export function SlackThread({ itemId, onClose, onChanged }: {
  itemId: number; onClose: () => void; onChanged: () => void;
}) {
  const [thread, setThread] = useState<SlackThreadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  const [composing, setComposing] = useState(false);
  const { width, startResize } = useDrawerWidth();

  const load = useCallback(() => {
    api.slackThread(itemId).then(setThread).catch((e) => setError(e.message));
  }, [itemId]);
  useEffect(load, [load]);

  const tree = useMemo(() => (thread ? buildTree(thread.messages) : []), [thread]);

  const act = async (fn: () => Promise<unknown>, message: string): Promise<void> => {
    setBusy(true);
    try { await fn(); setNotice(message); onChanged(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const send = async (): Promise<void> => {
    if (!reply.trim()) return;
    await act(async () => {
      const r = await api.slackReply(itemId, reply);
      setReply('');
      setComposing(false);
      setNotice(r.dryRun ? 'Dry run — the message was logged, not posted' : 'Posted to the thread');
      load();
    }, 'Sent');
  };

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" style={{ width }}>
        <div className="drawer-resize" onMouseDown={startResize} title="Drag to resize" />

        <div className="drawer-head">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <h1 style={{ fontSize: 16 }}>#{thread?.channelName ?? 'Loading…'}</h1>
              <div className="muted" style={{ fontSize: 12.5 }}>
                Slack
                {thread && ` · ${thread.messages.length} message${thread.messages.length === 1 ? '' : 's'}`}
                {thread?.permalink && (
                  <> · <a href={thread.permalink} target="_blank" rel="noopener noreferrer">Open in Slack</a></>
                )}
              </div>
            </div>
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>

        {notice && <div className="banner ok">{notice}</div>}
        {error && <div className="banner err">{error}</div>}

        <div className="slack-log">
          {thread == null && !error && <div className="empty">Loading…</div>}
          {tree.map((node) => (
            <div key={node.message.ts} className="slack-node">
              <SlackMessage m={node.message} />
              {node.replies.length > 0 && (
                <div className="slack-replies">
                  <div className="slack-replies-label">
                    {node.replies.length} repl{node.replies.length === 1 ? 'y' : 'ies'} in thread
                  </div>
                  {node.replies.map((r) => <SlackMessage key={r.ts} m={r} reply />)}
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="drawer-actions">
          {composing ? (
            <div className="slack-composer">
              <textarea
                value={reply}
                autoFocus
                rows={4}
                placeholder="Reply in thread…"
                onChange={(e) => setReply(e.target.value)}
              />
              <div className="muted" style={{ fontSize: 12 }}>
                Posts as a thread reply{thread?.postingAs ? ` — as ${thread.postingAs}` : ''}
              </div>
              <div className="row-actions">
                <button className="btn primary" disabled={busy || !reply.trim()} onClick={send}>Send</button>
                <button className="btn" disabled={busy} onClick={() => setComposing(false)}>Cancel</button>
              </div>
            </div>
          ) : (
            <>
              <button className="btn primary" onClick={() => setComposing(true)}>Reply</button>
              <button className="btn" disabled={busy} onClick={() => act(() => api.act(itemId, 'ignore', { reason: 'not_needed', scope: 'message' }), 'Ignored')}>Ignore</button>
              <button className="btn" disabled={busy} onClick={() => act(() => api.act(itemId, 'no-reply-needed'), 'Marked as no reply needed')}>No reply needed</button>
            </>
          )}
        </div>
      </aside>
    </>
  );
}

function SlackMessage({ m, reply = false }: { m: Msg; reply?: boolean }) {
  return (
    <div
      className={`slack-msg ${m.isInternal ? 'internal' : 'external'} ${m.inGroup ? 'in-group' : ''} ${m.deleted ? 'deleted' : ''} ${reply ? 'is-reply' : ''}`}
    >
      <div className="slack-msg-head">
        <strong>{m.author}</strong>
        <span className={`tag ${m.isInternal ? '' : 'client'}`}>{m.isInternal ? 'us' : 'client'}</span>
        <span className="muted">{timeAgo(m.at)}</span>
      </div>
      <div className="slack-msg-body">
        {m.deleted ? <em className="muted">deleted</em> : renderEmoji(m.text)}
      </div>
      {Object.keys(m.reactions).length > 0 && (
        <div className="slack-reactions">
          {Object.entries(m.reactions).map(([name, users]) => (
            <span key={name} className="slack-reaction" title={name}>
              {reactionLabel(name)} {users.length}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
