import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, timeAgo, type User } from './api';
import { Login } from './Login';
import { Thread } from './Thread';
import { SlackThread } from './SlackThread';
import { Inbox, type Filters } from './Inbox';
import { Settings } from './Settings';
import { MultiSelect } from './MultiSelect';
import { ErrorBoundary } from './ErrorBoundary';
import { readState, writeState } from './urlState';

type Page =
  | { kind: 'inbox'; title: string; subtitle: string; preset: Filters }
  | { kind: 'clients' }
  | { kind: 'teams' }
  | { kind: 'settings' };

type InboxPage = Extract<Page, { kind: 'inbox' }>;

const INBOX_SUBTITLE =
  'Needs reply, no reply needed, or all. Everything else is a filter on them.';

const INBOX: InboxPage = {
  kind: 'inbox',
  title: 'Inbox',
  subtitle: INBOX_SUBTITLE,
  preset: { source: 'gmail', view: 'all', tab: 'needs_reply' },
};

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [googleSso, setGoogleSso] = useState(false);
  const [loading, setLoading] = useState(true);
  // Restored from the URL, so a reload refreshes what you are looking at
  // instead of navigating you back to the Email inbox.
  const restored = readState();
  const [page, setPage] = useState<Page>(() => {
    if (!restored || restored.page === 'inbox') {
      return restored
        ? { kind: 'inbox', title: restored.title ?? 'Inbox', subtitle: restored.title ? 'Saved view.' : INBOX_SUBTITLE, preset: restored.filters }
        : INBOX;
    }
    return { kind: restored.page } as Page;
  });
  const [filters, setFilters] = useState<Filters>(restored?.filters ?? INBOX.preset);
  const [health, setHealth] = useState<any>(null);
  const [openItem, setOpenItem] = useState<number | null>(restored?.openItem ?? null);
  // Which drawer to render: a Slack item is a channel, not a mail thread.
  const [openSource, setOpenSource] = useState<'gmail' | 'slack'>(restored?.openSource ?? 'gmail');
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

  // Poll health so a worker that dies mid-session is noticed without a reload.
  useEffect(() => {
    if (!user) return;
    const id = setInterval(() => { void api.health().then(setHealth).catch(() => {}); }, 60_000);
    return () => clearInterval(id);
  }, [user]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Keep the address bar in step with where you are, including the open
  // drawer, so a reload puts it back.
  useEffect(() => {
    if (!user) return;
    writeState({
      page: page.kind,
      title: page.kind === 'inbox' ? page.title : undefined,
      filters: page.kind === 'inbox' ? filters : {},
      openItem: openItem ?? undefined,
      openSource,
    });
  }, [user, page, filters, openItem, openSource]);

  /**
   * Signing out clears where you were, not just who you are.
   *
   * The URL carries the view -- tab, filters, the waiting threshold -- so a
   * refresh puts you back. Left alone through a sign-out it also carried a
   * previous person's 15-hour threshold into the next session, which looked
   * like the default had changed.
   */
  const signOut = async (): Promise<void> => {
    await api.logout().catch(() => {});
    setPage(INBOX);
    setFilters(INBOX.preset);
    setOpenItem(null);
    setOpenSource('gmail');
    window.history.replaceState(null, '', window.location.pathname);
    setUser(null);
  };

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
          onClick={() => goInbox({ source: 'gmail', view: 'all', tab: 'needs_reply' })}
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
          <button className="nav-item" onClick={() => void signOut()}>Sign out</button>
        </div>
      </nav>

      <main className="main">
        <SyncBanner health={health} />
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
            onOpen={(id, source) => { setOpenItem(id); setOpenSource(source ?? 'gmail'); }}
            openItem={openItem}
            title={page.title}
            subtitle={page.subtitle}
            refreshKey={refreshKey}
            classifier={health?.classifier ?? 'heuristic'}
          />
        )}
        {page.kind === 'clients' && (
          <ClientsView clients={clients} users={users} onPick={(id) => goInbox({ source: 'gmail', view: 'all', clientId: String(id) }, 'Inbox')} />
        )}
        {page.kind === 'teams' && (
          <TeamsView teams={teams} onPick={(id) => goInbox({ source: 'gmail', view: 'all', teamId: String(id) }, 'Inbox')} />
        )}
        {page.kind === 'settings' && <Settings onChanged={refresh} clients={clients} />}
        </ErrorBoundary>
      </main>

      {openItem !== null && (openSource === 'slack' ? (
        <SlackThread
          itemId={openItem}
          onClose={() => setOpenItem(null)}
          onChanged={refresh}
        />
      ) : (
        <Thread
          itemId={openItem}
          user={user}
          clients={clients}
          onClose={() => setOpenItem(null)}
          onChanged={refresh}
        />
      ))}
    </div>
  );
}

/**
 * Clients, with a search box and filters.
 *
 * The list is every client the dashboard knows, which is well past a hundred
 * -- long enough that finding one meant scrolling, and "who is waiting on us"
 * meant reading every row.
 */
function ClientsView({ clients, users, onPick }: {
  clients: any[]; users: any[]; onPick: (id: number) => void;
}) {
  const [q, setQ] = useState('');
  const [services, setServices] = useState<string[]>([]);
  const [managers, setManagers] = useState<string[]>([]);
  const [waitingOnly, setWaitingOnly] = useState(false);

  // A client's "tier" is a comma-separated list of services, so the filter
  // offers the individual services rather than the exact combinations.
  const serviceOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const c of clients) {
      for (const part of String(c.tier ?? '').split(',')) {
        const name = part.trim();
        if (name) seen.add(name);
      }
    }
    return [...seen].sort().map((name) => ({ value: name, label: name }));
  }, [clients]);

  const managerOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const c of clients) if (c.account_manager) seen.add(c.account_manager);
    return [...seen].sort().map((name) => ({ value: name, label: name }));
  }, [clients]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return clients.filter((c) => {
      if (needle && !String(c.name ?? '').toLowerCase().includes(needle)
        && !String(c.account_manager ?? '').toLowerCase().includes(needle)) return false;
      if (waitingOnly && Number(c.open_count ?? 0) === 0) return false;
      if (services.length) {
        const mine = String(c.tier ?? '').split(',').map((x) => x.trim());
        if (!services.some((s) => mine.includes(s))) return false;
      }
      if (managers.length && !managers.includes(c.account_manager)) return false;
      return true;
    });
  }, [clients, q, services, managers, waitingOnly]);

  const waiting = shown.reduce((n, c) => n + Number(c.open_count ?? 0), 0);

  return (
    <>
      <div className="header">
        <div>
          <h1>Clients</h1>
          <div className="subtitle">Open volume, age and account manager per client. Click through to that client's mail.</div>
        </div>
        <div className="muted">{shown.length} of {clients.length} · {waiting} waiting</div>
      </div>

      <div className="toolbar split">
        <div className="toolbar-filters">
          <MultiSelect
            label="Service"
            searchable
            options={serviceOptions}
            selected={services}
            onChange={setServices}
          />
          <MultiSelect
            label="Account manager"
            searchable
            options={managerOptions}
            selected={managers}
            onChange={setManagers}
          />
          <button
            className={`chip ${waitingOnly ? 'on' : ''}`}
            onClick={() => setWaitingOnly((v) => !v)}
            title="Only clients with mail waiting on us"
          >
            Waiting on us
          </button>
        </div>
        <div className="toolbar-actions">
          {/* Same markup as the inbox search: the styling hangs off
              input.toolbar-search, so a wrapper with that class renders a
              27px box in a row of 34px controls. */}
          <div className="search-wrap">
            <svg className="search-icon" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              className="toolbar-search"
              placeholder="Search clients and managers…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            {q && <button className="search-clear" onClick={() => setQ('')} title="Clear search">×</button>}
          </div>
        </div>
      </div>

      <div className="card">
        <table>
          <thead><tr><th>Client</th><th>Services</th><th>Account manager</th><th className="num">Waiting</th><th>Longest wait</th></tr></thead>
          <tbody>
            {shown.map((c) => (
              <tr key={c.id} style={{ cursor: 'pointer' }} onClick={() => onPick(c.id)}>
                <td><strong>{c.name}</strong></td>
                <td>{c.tier ?? '—'}</td>
                <td className="muted">{c.account_manager ?? '—'}</td>
                <td className="num">{c.open_count}</td>
                <td className="muted">{timeAgo(c.oldest_open)}</td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr><td colSpan={5} className="empty">No client matches these filters.</td></tr>
            )}
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
          <thead><tr><th>Team</th><th className="num">Members</th><th className="num">Waiting</th><th>Longest wait</th></tr></thead>
          <tbody>
            {teams.length === 0 && <tr><td colSpan={5} className="muted">No teams yet. Add them in Settings.</td></tr>}
            {teams.map((t) => (
              <tr key={t.id} style={{ cursor: 'pointer' }} onClick={() => onPick(t.id)}>
                <td><strong>{t.name}</strong></td>
                <td className="num">{t.members}</td>
                <td className="num">{t.open_count}</td>
                <td className="muted">{timeAgo(t.oldest_open)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Says out loud when ingestion has stopped. Without this a dead worker is
 * indistinguishable from a quiet inbox: the dashboard keeps serving its last
 * snapshot and every number silently goes stale.
 */
function SyncBanner({ health }: { health: any }) {
  const sync = health?.sync;
  if (!sync) return null;

  if (sync.stale) {
    return (
      <div className="banner danger" style={{ marginBottom: 14 }}>
        <strong>Not syncing.</strong> No mailbox has updated since{' '}
        {sync.oldestSyncedAt ? new Date(sync.oldestSyncedAt).toLocaleString() : 'ever'}. Everything below is a
        stale snapshot — start the worker with <span className="mono">npm run worker</span>.
      </div>
    );
  }

  if (sync.staleMailboxes > 0) {
    return (
      <div className="banner warn" style={{ marginBottom: 14 }}>
        {sync.staleMailboxes} of {sync.activeMailboxes} mailboxes have not synced in the last{' '}
        {sync.thresholdMinutes} minutes. Catching up — counts will keep moving.
      </div>
    );
  }
  return null;
}
