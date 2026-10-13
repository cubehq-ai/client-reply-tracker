import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ThreadView, type User } from './api';
import { Message } from './Message';

const IGNORE_REASONS = [
  { value: 'not_needed', label: 'No reply needed' },
  { value: 'spam', label: 'Spam' },
  { value: 'not_a_client', label: 'Not a client' },
  { value: 'other', label: 'Other' },
];

const IGNORE_SCOPES = [
  { value: 'message', label: 'Ignore this message (reopens if they write again)' },
  { value: 'thread', label: 'Mute this thread (stays ignored)' },
  { value: 'sender', label: 'Always ignore this sender' },
  { value: 'domain', label: 'Always ignore this domain' },
];

const WIDTH_KEY = 'rq.drawer.width';
const MIN_WIDTH = 420;

export function Thread({ itemId, user, clients, users, onClose, onChanged }: {
  itemId: number; user: User; clients: any[]; users: any[];
  onClose: () => void; onChanged: () => void;
}) {
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [collision, setCollision] = useState<any>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [panel, setPanel] = useState<'ignore' | 'snooze' | 'link' | 'assign' | null>(null);

  // The composer is closed until a message is replied to.
  const [composer, setComposer] = useState<{ replyToMessageId: number; to: string; cc: string; subject: string } | null>(null);
  const [body, setBody] = useState('');
  const [sendAs, setSendAs] = useState('');
  const composerRef = useRef<HTMLDivElement | null>(null);

  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    return Number.isFinite(stored) && stored >= MIN_WIDTH ? stored : 780;
  });

  useEffect(() => {
    let live = true;
    setThread(null);
    setError(null);
    setComposer(null);
    setBody('');

    const apply = (t: ThreadView) => {
      if (!live) return;
      setThread(t);
      setSendAs((prev) => prev || t.reply.sendAs[0] || user.email);
      // Newest expanded, everything before it collapsed — as any mail client does.
      setExpanded((prev) => (prev.size ? prev : new Set(t.messages.length ? [t.messages[t.messages.length - 1]!.id] : [])));
    };

    api.thread(itemId, false)
      .then((t) => {
        apply(t);
        if (!live) return;
        setRefreshing(true);
        api.thread(itemId, true).then(apply).catch(() => {}).finally(() => live && setRefreshing(false));
      })
      .catch((e) => live && setError(e.message));

    api.act(itemId, 'lock').catch(() => {});
    return () => {
      live = false;
      api.act(itemId, 'unlock').catch(() => {});
    };
  }, [itemId, user.email]);

  // Drag the left edge to resize; the width is remembered per browser.
  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const move = (ev: MouseEvent) => {
      const next = Math.min(window.innerWidth - 120, Math.max(MIN_WIDTH, window.innerWidth - ev.clientX));
      setWidth(next);
    };
    const stop = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', stop);
      document.body.style.userSelect = '';
      setWidth((w) => { localStorage.setItem(WIDTH_KEY, String(w)); return w; });
    };
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', stop);
  }, []);

  async function run(fn: () => Promise<any>, message: string) {
    setBusy(true);
    setError(null);
    try { await fn(); setNotice(message); onChanged(); }
    catch (e: any) { setError(e.message ?? 'action failed'); }
    finally { setBusy(false); }
  }

  function openComposer(messageId: number, all: boolean) {
    const msg = thread?.messages.find((m) => m.id === messageId);
    if (!msg || !thread) return;
    const to = msg.direction === 'in' ? [msg.from] : msg.to;
    const cc = all
      ? [...new Set([...msg.to, ...msg.cc])].filter((e) => e !== user.email && !to.includes(e))
      : [];
    const base = (msg.subject || thread.subject).replace(/^((re|fwd?)\s*:\s*)+/i, '');
    setComposer({ replyToMessageId: messageId, to: to.join(', '), cc: cc.join(', '), subject: `Re: ${base}` });
    setExpanded((prev) => new Set([...prev, messageId]));
    setTimeout(() => composerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 60);
  }

  async function send(force = false, saveAsDraft = false) {
    if (!composer) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.act(itemId, 'send', {
        sendAs,
        replyToMessageId: composer.replyToMessageId,
        to: composer.to.split(',').map((s) => s.trim()).filter(Boolean),
        cc: composer.cc.split(',').map((s) => s.trim()).filter(Boolean),
        subject: composer.subject,
        body,
        force,
        saveAsDraft,
      });
      if (res.collision) { setCollision(res.collision); return; }
      setCollision(null);
      if (res.draftId) setNotice(`Saved as a Gmail draft (${res.draftId}).`);
      else if (res.dryRun) setNotice('SEND_ENABLED=false — the message was logged on the server, not sent.');
      else { setNotice('Sent.'); setComposer(null); setBody(''); }
      onChanged();
    } catch (e: any) {
      setError(e.message ?? 'send failed');
    } finally {
      setBusy(false);
    }
  }

  const otherLock = thread?.lockedBy && thread.lockedBy !== user.email ? thread.lockedBy : null;
  const lastMessageId = thread?.messages.length ? thread.messages[thread.messages.length - 1]!.id : null;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" style={{ width }}>
        <div className="drawer-resize" onMouseDown={startResize} title="Drag to resize" />

        <div className="drawer-head">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
            <div style={{ minWidth: 0 }}>
              <h1 style={{ fontSize: 16 }}>{thread?.subject ?? 'Loading…'}</h1>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {thread?.clientName ?? 'Unmatched'} · {thread?.state}
                {thread && ` · ${thread.messages.length} message${thread.messages.length === 1 ? '' : 's'}`}
                {refreshing && <span> · checking for new replies…</span>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {thread && thread.messages.length > 1 && (
                <button
                  className="btn small"
                  onClick={() => setExpanded((prev) =>
                    prev.size === thread.messages.length
                      ? new Set(lastMessageId ? [lastMessageId] : [])
                      : new Set(thread.messages.map((m) => m.id)),
                  )}
                >
                  {expanded.size === thread.messages.length ? 'Collapse all' : 'Expand all'}
                </button>
              )}
              <button className="btn small" onClick={onClose}>Close</button>
            </div>
          </div>
        </div>

        <div className="drawer-body">
          {error && <div className="banner danger">{error}</div>}
          {notice && <div className="banner info">{notice}</div>}
          {otherLock && <div className="banner warn">{otherLock} is replying to this right now.</div>}
          {collision && (
            <div className="banner warn">
              {collision.repliedBy} already replied {collision.minutesAgo} min ago.{' '}
              <button className="btn small" onClick={() => send(true)}>Send anyway</button>
            </div>
          )}

          {!thread && !error && <div className="empty">Loading thread…</div>}

          {thread?.messages.map((m) => (
            <Message
              key={m.id}
              message={m}
              open={expanded.has(m.id)}
              onToggle={() => setExpanded((prev) => {
                const next = new Set(prev);
                next.has(m.id) ? next.delete(m.id) : next.add(m.id);
                return next;
              })}
              onReply={() => openComposer(m.id, false)}
              onReplyAll={() => openComposer(m.id, true)}
            />
          ))}

          {composer && thread && (
            <div className="composer-card" ref={composerRef}>
              <div className="composer-head">
                <span>
                  Replying to <strong>{thread.messages.find((m) => m.id === composer.replyToMessageId)?.from}</strong>
                </span>
                <button className="btn small" onClick={() => { setComposer(null); setBody(''); }}>Discard</button>
              </div>
              <div className="composer-fields">
                <select value={sendAs} onChange={(e) => setSendAs(e.target.value)} title="Send as">
                  {thread.reply.sendAs.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                <input type="text" value={composer.to} placeholder="To"
                  onChange={(e) => setComposer({ ...composer, to: e.target.value })} />
                <input type="text" value={composer.cc} placeholder="Cc"
                  onChange={(e) => setComposer({ ...composer, cc: e.target.value })} />
              </div>
              <textarea className="composer" autoFocus value={body} placeholder="Write your reply…"
                onChange={(e) => setBody(e.target.value)} />
              <div className="composer-actions">
                <button className="btn primary" disabled={busy || !body.trim()} onClick={() => send(false)}>Send</button>
                <button className="btn" disabled={busy || !body.trim()} onClick={() => send(false, true)}>Save as draft</button>
                <button className="btn" disabled={busy} onClick={() => run(async () => {
                  const r = await api.act(itemId, 'draft');
                  setBody(r.draft);
                }, 'Draft generated — edit before sending.')}>AI draft</button>
              </div>
            </div>
          )}
        </div>

        <div className="drawer-foot">
          <div className="toolbar" style={{ marginBottom: panel ? 12 : 0 }}>
            {lastMessageId !== null && !composer && (
              <button className="btn small primary" onClick={() => openComposer(lastMessageId, true)}>Reply</button>
            )}
            <button className={`btn small ${panel === 'ignore' ? 'primary' : ''}`} onClick={() => setPanel(panel === 'ignore' ? null : 'ignore')}>Ignore</button>
            <button className={`btn small ${panel === 'snooze' ? 'primary' : ''}`} onClick={() => setPanel(panel === 'snooze' ? null : 'snooze')}>Snooze</button>
            <button className="btn small" disabled={busy} onClick={() => run(() => api.act(itemId, 'handled'), 'Marked handled elsewhere.')}>Handled elsewhere</button>
            <button className={`btn small ${panel === 'assign' ? 'primary' : ''}`} onClick={() => setPanel(panel === 'assign' ? null : 'assign')}>Reassign</button>
            {thread?.state === 'fyi' && (
              <button className="btn small" disabled={busy} onClick={() => run(() => api.act(itemId, 'needs-reply'), 'Moved to Needs Reply.')}>Actually needs reply</button>
            )}
            {thread?.state === 'ignored' && (
              <button className="btn small" disabled={busy} onClick={() => run(() => api.act(itemId, 'undo-ignore'), 'Ignore undone.')}>Undo ignore</button>
            )}
            {!thread?.clientName && (
              <button className={`btn small ${panel === 'link' ? 'primary' : ''}`} onClick={() => setPanel(panel === 'link' ? null : 'link')}>Link to client</button>
            )}
          </div>

          {panel === 'ignore' && <IgnorePanel busy={busy} onIgnore={(reason, scope) => run(() => api.act(itemId, 'ignore', { reason, scope }), 'Ignored.')} />}
          {panel === 'snooze' && <SnoozePanel busy={busy} onSnooze={(until) => run(() => api.act(itemId, 'snooze', { until }), 'Snoozed.')} />}
          {panel === 'assign' && (
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <select defaultValue="" onChange={(e) => e.target.value && run(() => api.act(itemId, 'reassign', { ownerEmail: e.target.value }), `Reassigned to ${e.target.value}.`)}>
                <option value="">Reassign to…</option>
                {users.map((u) => <option key={u.email} value={u.email}>{u.email}</option>)}
              </select>
            </div>
          )}
          {panel === 'link' && (
            <LinkPanel clients={clients} busy={busy} onLink={(clientId, mode) => run(() => api.act(itemId, 'link-client', { clientId, mode }), 'Linked.')} />
          )}
        </div>
      </aside>
    </>
  );
}

function IgnorePanel({ busy, onIgnore }: { busy: boolean; onIgnore: (reason: string, scope: string) => void }) {
  const [reason, setReason] = useState('not_needed');
  const [scope, setScope] = useState('message');
  return (
    <div className="stack" style={{ gap: 8 }}>
      <select value={reason} onChange={(e) => setReason(e.target.value)}>
        {IGNORE_REASONS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
      </select>
      <select value={scope} onChange={(e) => setScope(e.target.value)}>
        {IGNORE_SCOPES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
      </select>
      <div><button className="btn danger" disabled={busy} onClick={() => onIgnore(reason, scope)}>Confirm ignore</button></div>
    </div>
  );
}

function SnoozePanel({ busy, onSnooze }: { busy: boolean; onSnooze: (until: string) => void }) {
  const presets = [
    { label: 'In 3 hours', ms: 3 * 3600_000 },
    { label: 'Tomorrow morning', ms: 18 * 3600_000 },
    { label: 'Next week', ms: 7 * 86400_000 },
  ];
  const [custom, setCustom] = useState('');
  return (
    <div className="toolbar" style={{ marginBottom: 0 }}>
      {presets.map((p) => (
        <button key={p.label} className="btn" disabled={busy} onClick={() => onSnooze(new Date(Date.now() + p.ms).toISOString())}>{p.label}</button>
      ))}
      <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
      <button className="btn" disabled={busy || !custom} onClick={() => onSnooze(new Date(custom).toISOString())}>Snooze until</button>
    </div>
  );
}

function LinkPanel({ clients, busy, onLink }: { clients: any[]; busy: boolean; onLink: (clientId: number, mode: string) => void }) {
  const [clientId, setClientId] = useState('');
  const [mode, setMode] = useState('email');
  return (
    <div className="toolbar" style={{ marginBottom: 0 }}>
      <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
        <option value="">Choose client…</option>
        {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <select value={mode} onChange={(e) => setMode(e.target.value)}>
        <option value="email">Link this address</option>
        <option value="domain">Link the whole domain</option>
      </select>
      <button className="btn primary" disabled={busy || !clientId} onClick={() => onLink(Number(clientId), mode)}>Link</button>
    </div>
  );
}
