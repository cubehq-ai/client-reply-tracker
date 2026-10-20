import { useCallback, useEffect, useState } from 'react';
import { api, timeAgo, type SlackThread as SlackThreadView } from './api';

/**
 * A Slack item in the drawer.
 *
 * A channel message out of context rarely reads as anything, so the view
 * shows the ten messages before the group and everything after it, with the
 * group itself marked. Replies always post as a thread reply on the group's
 * first message, which is what makes them detectable on the next sync pass.
 */
export function SlackThread({ itemId, onClose, onChanged }: {
  itemId: number; onClose: () => void; onChanged: () => void;
}) {
  const [thread, setThread] = useState<SlackThreadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState('');
  const [composing, setComposing] = useState(false);

  const load = useCallback(() => {
    api.slackThread(itemId).then(setThread).catch((e) => setError(e.message));
  }, [itemId]);

  useEffect(load, [load]);

  const act = async (fn: () => Promise<unknown>, message: string): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      setNotice(message);
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const send = async (): Promise<void> => {
    if (!reply.trim()) return;
    await act(async () => {
      const r = await api.slackReply(itemId, reply);
      setReply('');
      setComposing(false);
      // A dry run posts nothing, so say so rather than implying it went out.
      setNotice(r.dryRun ? 'Dry run — the message was logged, not posted' : 'Posted to the thread');
      load();
    }, 'Sent');
  };

  if (error && !thread) {
    return (
      <div className="drawer">
        <div className="drawer-head"><strong>Could not load</strong><button className="btn" onClick={onClose}>Close</button></div>
        <div className="banner err">{error}</div>
      </div>
    );
  }
  if (!thread) return <div className="drawer"><div className="empty">Loading…</div></div>;

  return (
    <div className="drawer">
      <div className="drawer-head">
        {/* .drawer-head is a plain block, so the head lays itself out, the
            same way the mail drawer does. */}
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <h1 style={{ fontSize: 16 }}>#{thread.channelName}</h1>
            <div className="muted" style={{ fontSize: 12.5 }}>
              Slack · {thread.messages.length} message{thread.messages.length === 1 ? '' : 's'}
              {thread.permalink && (
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
        {thread.messages.map((m) => (
          <div
            key={m.ts}
            className={`slack-msg ${m.isInternal ? 'internal' : 'external'} ${m.inGroup ? 'in-group' : ''} ${m.deleted ? 'deleted' : ''}`}
          >
            <div className="slack-msg-head">
              <strong>{m.author}</strong>
              {!m.isInternal && <span className="tag">client</span>}
              {m.threadOf && <span className="tag">thread</span>}
              <span className="muted">{timeAgo(m.at)}</span>
            </div>
            <div className="slack-msg-body">{m.deleted ? <em className="muted">deleted</em> : m.text}</div>
            {Object.keys(m.reactions).length > 0 && (
              <div className="slack-reactions">
                {Object.entries(m.reactions).map(([name, users]) => (
                  <span key={name} className="slack-reaction">:{name}: {users.length}</span>
                ))}
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
              Posts as a thread reply{thread.postingAs ? ` — as ${thread.postingAs}` : ''}
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
    </div>
  );
}
