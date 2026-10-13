import { useEffect, useState } from 'react';
import { api, timeAgo, type ThreadView, type User } from './api';

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

export function Thread({ itemId, user, clients, users, onClose, onChanged }: {
  itemId: number; user: User; clients: any[]; users: any[];
  onClose: () => void; onChanged: () => void;
}) {
  const [thread, setThread] = useState<ThreadView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState('');
  const [to, setTo] = useState('');
  const [cc, setCc] = useState('');
  const [sendAs, setSendAs] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [collision, setCollision] = useState<any>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [panel, setPanel] = useState<'reply' | 'ignore' | 'snooze' | 'link' | 'assign' | null>('reply');
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    let live = true;
    setThread(null);
    setError(null);
    setRefreshing(false);

    const apply = (t: ThreadView) => {
      if (!live) return;
      setThread(t);
      setTo(t.reply.to.join(', '));
      setCc(t.reply.cc.join(', '));
      setSendAs((prev) => prev || t.reply.sendAs[0] || user.email);
      setExpanded((prev) =>
        prev.size ? prev : new Set(t.messages.length ? [t.messages[t.messages.length - 1]!.id] : []),
      );
    };

    // Render from the database first: every message body is already stored,
    // so there is nothing to wait for.
    api.thread(itemId, false)
      .then((t) => {
        apply(t);
        // Then re-read the thread from Gmail in the background, so a reply
        // someone just sent still shows up without holding the UI open.
        if (!live) return;
        setRefreshing(true);
        api.thread(itemId, true)
          .then(apply)
          .catch(() => {})
          .finally(() => live && setRefreshing(false));
      })
      .catch((e) => live && setError(e.message));

    api.act(itemId, 'lock').catch(() => {});
    return () => {
      live = false;
      api.act(itemId, 'unlock').catch(() => {});
    };
  }, [itemId, user.email]);

  async function run(fn: () => Promise<any>, message: string) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      setNotice(message);
      onChanged();
    } catch (e: any) {
      setError(e.message ?? 'action failed');
    } finally {
      setBusy(false);
    }
  }

  async function send(force = false, saveAsDraft = false) {
    const payload = {
      sendAs,
      to: to.split(',').map((s) => s.trim()).filter(Boolean),
      cc: cc.split(',').map((s) => s.trim()).filter(Boolean),
      subject: thread!.reply.subject,
      body,
      force,
      saveAsDraft,
    };
    setBusy(true);
    setError(null);
    try {
      const res = await api.act(itemId, 'send', payload);
      if (res.collision) {
        setCollision(res.collision);
        return;
      }
      setCollision(null);
      if (res.draftId) setNotice(`Saved as a Gmail draft (${res.draftId}).`);
      else if (res.dryRun) setNotice('SEND_ENABLED=false — the message was logged on the server, not sent.');
      else setNotice('Sent.');
      onChanged();
    } catch (e: any) {
      setError(e.message ?? 'send failed');
    } finally {
      setBusy(false);
    }
  }

  const otherLock = thread?.lockedBy && thread.lockedBy !== user.email ? thread.lockedBy : null;

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer">
        <div className="drawer-head">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <h1 style={{ fontSize: 16 }}>{thread?.subject ?? 'Loading…'}</h1>
              <div className="muted" style={{ fontSize: 12.5 }}>
                {thread?.clientName ?? 'Unmatched'} · {thread?.state}
                {refreshing && <span className="muted"> · checking for new replies…</span>}
              </div>
            </div>
            <button className="btn small" onClick={onClose}>Close</button>
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

          {thread?.messages.map((m) => {
            const open = expanded.has(m.id);
            return (
              <div key={m.id} className={`msg ${m.direction === 'out' ? 'out' : ''}`}>
                <div className="msg-head">
                  <span>
                    <strong>{m.from}</strong>
                    {m.isDraft && <span className="tag" style={{ marginLeft: 6 }}>draft</span>}
                    {m.filterReason && <span className="tag" style={{ marginLeft: 6 }}>{m.filterReason}</span>}
                  </span>
                  <span className="muted">{new Date(m.date).toLocaleString()}</span>
                </div>
                <div
                  className={`msg-body ${open ? '' : 'collapsed'}`}
                  onClick={() => setExpanded((s) => {
                    const next = new Set(s);
                    open ? next.delete(m.id) : next.add(m.id);
                    return next;
                  })}
                  style={{ cursor: 'pointer' }}
                >
                  {m.body || m.snippet || '(no body stored)'}
                </div>
              </div>
            );
          })}
        </div>

        <div className="drawer-foot">
          <div className="toolbar" style={{ marginBottom: panel ? 12 : 0 }}>
            <button className={`btn small ${panel === 'reply' ? 'primary' : ''}`} onClick={() => setPanel(panel === 'reply' ? null : 'reply')}>Reply</button>
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

          {panel === 'reply' && thread && (
            <div className="stack" style={{ gap: 8 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <select value={sendAs} onChange={(e) => setSendAs(e.target.value)} title="Send as">
                  {thread.reply.sendAs.map((a) => <option key={a} value={a}>{a}</option>)}
                </select>
                <input type="text" value={to} onChange={(e) => setTo(e.target.value)} placeholder="To" style={{ flex: 1, minWidth: 180 }} />
                <input type="text" value={cc} onChange={(e) => setCc(e.target.value)} placeholder="Cc" style={{ flex: 1, minWidth: 140 }} />
              </div>
              <textarea className="composer" value={body} placeholder="Write your reply…" onChange={(e) => setBody(e.target.value)} />
              <div className="toolbar" style={{ marginBottom: 0 }}>
                <button className="btn primary" disabled={busy || !body.trim()} onClick={() => send(false)}>Send</button>
                <button className="btn" disabled={busy || !body.trim()} onClick={() => send(false, true)}>Save as Gmail draft</button>
                <button className="btn" disabled={busy} onClick={() => run(async () => {
                  const r = await api.act(itemId, 'draft');
                  setBody(r.draft);
                }, 'Draft generated — edit before sending.')}>AI draft</button>
              </div>
            </div>
          )}

          {panel === 'ignore' && <IgnorePanel busy={busy} onIgnore={(reason, scope) =>
            run(() => api.act(itemId, 'ignore', { reason, scope }), 'Ignored.')} />}

          {panel === 'snooze' && <SnoozePanel busy={busy} onSnooze={(until) =>
            run(() => api.act(itemId, 'snooze', { until }), 'Snoozed.')} />}

          {panel === 'assign' && (
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <select defaultValue="" onChange={(e) => e.target.value && run(() => api.act(itemId, 'reassign', { ownerEmail: e.target.value }), `Reassigned to ${e.target.value}.`)}>
                <option value="">Reassign to…</option>
                {users.map((u) => <option key={u.email} value={u.email}>{u.email}</option>)}
              </select>
            </div>
          )}

          {panel === 'link' && (
            <LinkPanel clients={clients} busy={busy} onLink={(clientId, mode) =>
              run(() => api.act(itemId, 'link-client', { clientId, mode }), 'Linked.')} />
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
        <button key={p.label} className="btn" disabled={busy}
          onClick={() => onSnooze(new Date(Date.now() + p.ms).toISOString())}>{p.label}</button>
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
