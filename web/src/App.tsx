import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, formatDue, timeAgo, type QueueItem, type User } from './api';
import { Login } from './Login';
import { Thread } from './Thread';
import { Admin } from './Admin';
import { Metrics } from './Metrics';

const QUEUES = [
  { key: 'needs_reply', label: 'Needs Reply' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'unmatched', label: 'Unmatched' },
  { key: 'low_confidence', label: 'Low Confidence' },
  { key: 'fyi', label: 'FYI' },
  { key: 'snoozed', label: 'Snoozed' },
  { key: 'replied', label: 'Replied' },
  { key: 'awaiting_client', label: 'Awaiting Client' },
  { key: 'ignored', label: 'Ignored' },
  { key: 'filtered', label: 'Filtered' },
];

type Page = { kind: 'queue'; queue: string } | { kind: 'clients' } | { kind: 'metrics' } | { kind: 'admin' };

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [googleSso, setGoogleSso] = useState(false);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>({ kind: 'queue', queue: 'needs_reply' });
  const [view, setView] = useState('all');
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [health, setHealth] = useState<any>(null);
  const [openItem, setOpenItem] = useState<number | null>(null);
  const [clients, setClients] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  const loadSession = useCallback(async () => {
    try {
      const res = await api.me();
      setUser(res.user);
      setGoogleSso(res.googleSso);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadSession(); }, [loadSession]);

  useEffect(() => {
    if (!user) return;
    void api.counts(view).then(setCounts).catch(() => {});
    void api.health().then(setHealth).catch(() => {});
    void api.clients(view).then((r) => setClients(r.clients)).catch(() => {});
    void api.users().then((r) => setUsers(r.users)).catch(() => {});
  }, [user, view, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  if (loading) return <div className="empty">Loading…</div>;
  if (!user) return <Login googleSso={googleSso} onSignedIn={() => { setLoading(true); void loadSession(); }} />;

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          ReplyQueue
          <small>{user.email} · {user.role}</small>
        </div>

        <select value={view} onChange={(e) => setView(e.target.value)} style={{ marginBottom: 8 }}>
          <option value="all">{user.role === 'admin' ? 'All items' : 'Everything I can see'}</option>
          <option value="mine">My items</option>
          <option value="team">My team</option>
        </select>

        <div className="nav-group">Queues</div>
        {QUEUES.map((q) => (
          <button
            key={q.key}
            className={`nav-item ${page.kind === 'queue' && page.queue === q.key ? 'active' : ''}`}
            onClick={() => { setPage({ kind: 'queue', queue: q.key }); setOpenItem(null); }}
          >
            <span>{q.label}</span>
            <span className={`badge ${q.key === 'overdue' && (counts[q.key] ?? 0) > 0 ? 'alert' : ''}`}>{counts[q.key] ?? 0}</span>
          </button>
        ))}

        <div className="nav-group">Views</div>
        <button className={`nav-item ${page.kind === 'clients' ? 'active' : ''}`} onClick={() => setPage({ kind: 'clients' })}>By client</button>
        <button className={`nav-item ${page.kind === 'metrics' ? 'active' : ''}`} onClick={() => setPage({ kind: 'metrics' })}>Metrics</button>
        {user.role === 'admin' && (
          <button className={`nav-item ${page.kind === 'admin' ? 'active' : ''}`} onClick={() => setPage({ kind: 'admin' })}>Admin</button>
        )}

        <div style={{ marginTop: 'auto', paddingTop: 16 }}>
          {health && (
            <div className="muted" style={{ fontSize: 11, padding: '0 8px 10px', lineHeight: 1.6 }}>
              Gmail: <strong>{health.googleBackend}</strong><br />
              Send: <strong>{health.sendEnabled ? 'live' : 'dry run'}</strong><br />
              Classifier: <strong>{health.classifier}</strong><br />
              Push: <strong>{health.pubsub}</strong>
            </div>
          )}
          <button className="nav-item" onClick={() => api.logout().then(() => setUser(null))}>Sign out</button>
        </div>
      </nav>

      <main className="main">
        {page.kind === 'queue' && (
          <Queue
            key={`${page.queue}-${view}-${refreshKey}`}
            queue={page.queue}
            view={view}
            clients={clients}
            users={users}
            onOpen={setOpenItem}
            openItem={openItem}
          />
        )}
        {page.kind === 'clients' && <Clients clients={clients} onPick={(id) => { setPage({ kind: 'queue', queue: 'needs_reply' }); void id; }} />}
        {page.kind === 'metrics' && <Metrics />}
        {page.kind === 'admin' && <Admin onChanged={refresh} />}
      </main>

      {openItem !== null && (
        <Thread
          itemId={openItem}
          user={user}
          clients={clients}
          users={users}
          onClose={() => setOpenItem(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

const QUEUE_BLURB: Record<string, string> = {
  needs_reply: 'Client mail waiting on us, highest priority and oldest first.',
  overdue: 'Past the SLA for the client tier.',
  unmatched: 'External senders we could not map to a client. Link them to stop guessing.',
  low_confidence: 'The classifier was unsure. Shown in Needs Reply too, never hidden.',
  fyi: 'No reply needed, by the classifier. Promote anything it got wrong.',
  snoozed: 'Hidden until their wake time, or until the client writes again.',
  replied: 'Answered in the last 7 days.',
  awaiting_client: 'We replied and are waiting on them.',
  ignored: 'Ignored in the last 30 days. Every one is undoable.',
  filtered: 'Caught by the rules before any model call. Audit them here.',
};

function Queue({ queue, view, clients, users, onOpen, openItem }: {
  queue: string; view: string; clients: any[]; users: any[];
  onOpen: (id: number) => void; openItem: number | null;
}) {
  const [data, setData] = useState<{ items: QueueItem[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Record<string, string>>({});

  const params = useMemo(() => {
    const p: Record<string, string> = { view, limit: '100' };
    for (const [k, v] of Object.entries(filters)) if (v) p[k] = v;
    return p;
  }, [view, filters]);

  useEffect(() => {
    let live = true;
    setData(null);
    api.queue(queue, params).then((d) => live && setData(d)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [queue, params, openItem]);

  const label = QUEUES.find((q) => q.key === queue)?.label ?? queue;

  return (
    <>
      <div className="header">
        <div>
          <h1>{label}</h1>
          <div className="subtitle">{QUEUE_BLURB[queue]}</div>
        </div>
        <div className="muted">{data ? `${data.total} item${data.total === 1 ? '' : 's'}` : ''}</div>
      </div>

      <div className="toolbar">
        <select value={filters.clientId ?? ''} onChange={(e) => setFilters((f) => ({ ...f, clientId: e.target.value }))}>
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={filters.ownerUserId ?? ''} onChange={(e) => setFilters((f) => ({ ...f, ownerUserId: e.target.value }))}>
          <option value="">Any owner</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
        </select>
        <select value={filters.age ?? ''} onChange={(e) => setFilters((f) => ({ ...f, age: e.target.value }))}>
          <option value="">Any age</option>
          <option value="4h">Under 4h</option>
          <option value="24h">4–24h</option>
          <option value="3d">1–3 days</option>
          <option value="older">Over 3 days</option>
        </select>
        <select value={filters.priority ?? ''} onChange={(e) => setFilters((f) => ({ ...f, priority: e.target.value }))}>
          <option value="">Any priority</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
        <input type="text" placeholder="Search subject…" value={filters.search ?? ''}
          onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))} />
      </div>

      {error && <div className="banner danger">{error}</div>}

      <div className="card list">
        {!data && !error && <div className="empty">Loading…</div>}
        {data?.items.length === 0 && <div className="empty">Nothing here. That is the goal.</div>}
        {data?.items.map((it) => (
          <div key={it.id} className={`row ${openItem === it.id ? 'selected' : ''}`} onClick={() => onOpen(it.id)}>
            <div className="row-title">
              {it.subject}
              {it.priority === 'high' && <span className="tag high">high</span>}
              {it.overdue && <span className="tag overdue">overdue</span>}
              {it.lowConfidence && <span className="tag low-conf">low confidence</span>}
              {it.reopenCount > 0 && <span className="tag">reopened ×{it.reopenCount}</span>}
              {it.muted && <span className="tag">muted</span>}
              {it.filterReason && <span className="tag">{it.filterReason}</span>}
              {it.lockedBy && <span className="tag">{it.lockedBy} replying</span>}
            </div>
            <div className="row-right">
              {timeAgo(it.lastExternalAt)}
              {it.slaDueAt && it.state === 'needs_reply' && <div style={{ fontSize: 11 }}>{formatDue(it.slaDueAt)}</div>}
              {it.snoozedUntil && <div style={{ fontSize: 11 }}>wakes {new Date(it.snoozedUntil).toLocaleString()}</div>}
            </div>
            <div className="row-meta">
              <span className="tag client">{it.clientName ?? 'unmatched'}</span>
              <span>{it.fromEmail}</span>
              <span>owner: {it.ownerEmail ?? 'unowned'}</span>
              {it.intent && <span>{it.intent}</span>}
              {it.summary && <span style={{ flexBasis: '100%' }}>{it.summary}</span>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Clients({ clients, onPick }: { clients: any[]; onPick: (id: number) => void }) {
  return (
    <>
      <div className="header"><div><h1>By client</h1><div className="subtitle">Open volume, age and SLA breaches per client.</div></div></div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Client</th><th>Tier</th><th>Account manager</th>
              <th className="num">Open</th><th className="num">Overdue</th><th>Oldest open</th>
            </tr>
          </thead>
          <tbody>
            {clients.map((c) => (
              <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => onPick(c.id)}>
                <td><strong>{c.name}</strong></td>
                <td>{c.tier ?? '—'}</td>
                <td className="muted">{c.account_manager ?? '—'}</td>
                <td className="num">{c.open_count}</td>
                <td className="num" style={{ color: c.overdue_count > 0 ? 'var(--danger)' : undefined }}>{c.overdue_count}</td>
                <td className="muted">{timeAgo(c.oldest_open)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
