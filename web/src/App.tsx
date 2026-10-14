import { useCallback, useEffect, useState } from 'react';
import { api, timeAgo, type User } from './api';
import { Login } from './Login';
import { Thread } from './Thread';
import { Inbox, type Filters } from './Inbox';
import { Settings } from './Settings';
import { Metrics } from './Metrics';
import { ErrorBoundary } from './ErrorBoundary';

type Page =
  | { kind: 'inbox'; title: string; subtitle: string; preset: Filters }
  | { kind: 'clients' }
  | { kind: 'teams' }
  | { kind: 'metrics' }
  | { kind: 'settings' };

type InboxPage = Extract<Page, { kind: 'inbox' }>;

const INBOX_SUBTITLE =
  'Client mail with no reply from us. Status, overdue and unmatched are filters on it, not separate places.';

const INBOX: InboxPage = {
  kind: 'inbox',
  title: 'Inbox',
  subtitle: INBOX_SUBTITLE,
  preset: { source: 'gmail', view: 'all', status: 'needs_reply', freshness: 'aged' },
};

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [googleSso, setGoogleSso] = useState(false);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>(INBOX);
  const [filters, setFilters] = useState<Filters>(INBOX.preset);
  const [health, setHealth] = useState<any>(null);
  const [openItem, setOpenItem] = useState<number | null>(null);
  const [clients, setClients] = useState<any[]>([]);
  const [users, setUsers] = useState<any[]>([]);
  const [teams, setTeams] = useState<any[]>([]);
  const [views, setViews] = useState<any[]>([]);
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

  const loadViews = useCallback(() => { void api.savedViews().then((r) => setViews(r.views)).catch(() => {}); }, []);

  useEffect(() => {
    if (!user) return;
    void api.health().then(setHealth).catch(() => {});
    void api.clients('all').then((r) => setClients(r.clients)).catch(() => {});
    void api.users().then((r) => setUsers(r.users)).catch(() => {});
    void api.teams('all').then((r) => setTeams(r.teams)).catch(() => {});
    loadViews();
  }, [user, refreshKey, loadViews]);

  useEffect(() => {
    window.addEventListener('rq:views-changed', loadViews);
    return () => window.removeEventListener('rq:views-changed', loadViews);
  }, [loadViews]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  const goInbox = (preset: Filters, title = 'Inbox', subtitle = INBOX_SUBTITLE) => {
    setPage({ kind: 'inbox', title, subtitle, preset });
    setFilters(preset);
    setOpenItem(null);
  };

  if (loading) return <div className="empty">Loading…</div>;
  if (!user) return <Login googleSso={googleSso} onSignedIn={() => { setLoading(true); void loadSession(); }} />;

  const isInbox = page.kind === 'inbox';

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="brand">
          ReplyQueue
          <small>{user.email} · {user.role}</small>
        </div>

        <div className="nav-group">Work</div>
        <button
          className={`nav-item ${isInbox && page.title === 'Inbox' ? 'active' : ''}`}
          onClick={() => goInbox({ source: 'gmail', view: 'all', status: 'needs_reply', freshness: 'aged' })}
        >
          Inbox
        </button>

        {views.length > 0 && <div className="nav-group">Saved views</div>}
        {views.map((v) => (
          <button
            key={v.id}
            className={`nav-item ${isInbox && page.title === v.name ? 'active' : ''}`}
            onClick={() => goInbox({ source: 'gmail', view: 'all', ...v.filters }, v.name, 'Saved view.')}
          >
            <span>★ {v.name}</span>
            <span
              className="badge"
              title="Delete this view"
              onClick={(e) => { e.stopPropagation(); void api.deleteSavedView(v.id).then(loadViews); }}
            >×</span>
          </button>
        ))}

        <div className="nav-group">Insight</div>
        <button className={`nav-item ${page.kind === 'clients' ? 'active' : ''}`} onClick={() => setPage({ kind: 'clients' })}>Clients</button>
        <button className={`nav-item ${page.kind === 'teams' ? 'active' : ''}`} onClick={() => setPage({ kind: 'teams' })}>Teams</button>
        <button className={`nav-item ${page.kind === 'metrics' ? 'active' : ''}`} onClick={() => setPage({ kind: 'metrics' })}>Metrics</button>

        <div className="nav-group">Setup</div>
        <button className={`nav-item ${page.kind === 'settings' ? 'active' : ''}`} onClick={() => setPage({ kind: 'settings' })}>Settings</button>

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
        <ErrorBoundary key={page.kind + (isInbox ? page.title : '')}>
        {isInbox && (
          <Inbox
            key={page.title}
            user={user}
            filters={filters}
            setFilters={setFilters}
            clients={clients}
            users={users}
            teams={teams}
            onOpen={setOpenItem}
            openItem={openItem}
            title={page.title}
            subtitle={page.subtitle}
            refreshKey={refreshKey}
            classifier={health?.classifier ?? 'heuristic'}
          />
        )}
        {page.kind === 'clients' && (
          <ClientsView clients={clients} onPick={(id) => goInbox({ source: 'gmail', view: 'all', clientId: String(id) }, 'Inbox')} />
        )}
        {page.kind === 'teams' && (
          <TeamsView teams={teams} onPick={(id) => goInbox({ source: 'gmail', view: 'all', teamId: String(id) }, 'Inbox')} />
        )}
        {page.kind === 'metrics' && <Metrics />}
        {page.kind === 'settings' && <Settings onChanged={refresh} clients={clients} />}
        </ErrorBoundary>
      </main>

      {openItem !== null && (
        <Thread
          itemId={openItem}
          user={user}
          clients={clients}
          onClose={() => setOpenItem(null)}
          onChanged={refresh}
        />
      )}
    </div>
  );
}

function ClientsView({ clients, onPick }: { clients: any[]; onPick: (id: number) => void }) {
  return (
    <>
      <div className="header"><div><h1>Clients</h1><div className="subtitle">Open volume, age and SLA breaches per client. Click through to that client's mail.</div></div></div>
      <div className="card">
        <table>
          <thead><tr><th>Client</th><th>Services</th><th>Account manager</th><th className="num">Open</th><th className="num">Overdue</th><th>Oldest open</th></tr></thead>
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

function TeamsView({ teams, onPick }: { teams: any[]; onPick: (id: number) => void }) {
  return (
    <>
      <div className="header"><div><h1>Teams</h1><div className="subtitle">Who is carrying what. Click through to that team's mail.</div></div></div>
      <div className="card">
        <table>
          <thead><tr><th>Team</th><th className="num">Members</th><th className="num">Open</th><th className="num">Overdue</th><th>Oldest open</th></tr></thead>
          <tbody>
            {teams.length === 0 && <tr><td colSpan={5} className="muted">No teams yet. Add them in Settings.</td></tr>}
            {teams.map((t) => (
              <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => onPick(t.id)}>
                <td><strong>{t.name}</strong></td>
                <td className="num">{t.members}</td>
                <td className="num">{t.open_count}</td>
                <td className="num" style={{ color: t.overdue_count > 0 ? 'var(--danger)' : undefined }}>{t.overdue_count}</td>
                <td className="muted">{timeAgo(t.oldest_open)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
