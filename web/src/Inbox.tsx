import { useEffect, useMemo, useState } from 'react';
import { api, formatDue, timeAgo, type InboxFacets, type QueueItem, type User } from './api';

/** Channel tabs. Only Email exists in v1; the others are visibly not ready. */
const CHANNELS = [
  { key: 'gmail', label: 'Email', ready: true },
  { key: 'slack', label: 'Slack', ready: false },
  { key: 'whatsapp', label: 'WhatsApp', ready: false },
];

const STATUSES = [
  { key: 'needs_reply', label: 'Needs reply' },
  { key: 'fyi', label: 'FYI' },
  { key: 'snoozed', label: 'Snoozed' },
  { key: 'replied', label: 'Replied' },
  { key: 'handled_elsewhere', label: 'Handled elsewhere' },
  { key: 'ignored', label: 'Ignored' },
  { key: 'auto_ignored', label: 'Filtered' },
];

/** Overlays are subsets of the list above, never siblings of it. */
const OVERLAYS = [
  { key: 'overdue', label: 'Overdue', facet: 'overdue' as const },
  { key: 'unmatched', label: 'Unmatched', facet: 'unmatched' as const },
  { key: 'lowConfidence', label: 'Low confidence', facet: 'lowConfidence' as const },
  { key: 'awaitingClient', label: 'Awaiting client', facet: 'awaitingClient' as const },
];

export type Filters = Record<string, string>;

export function Inbox({ user, filters, setFilters, clients, users, teams, onOpen, openItem, title, subtitle }: {
  user: User; filters: Filters; setFilters: (f: Filters) => void;
  clients: any[]; users: any[]; teams: any[];
  onOpen: (id: number) => void; openItem: number | null;
  title: string; subtitle: string;
}) {
  const [data, setData] = useState<{ items: QueueItem[]; total: number; facets: InboxFacets } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const params = useMemo(() => {
    const p: Filters = { limit: '100', ...filters };
    if (!p.source) p.source = 'gmail';
    return p;
  }, [filters]);

  useEffect(() => {
    let live = true;
    setData(null);
    setError(null);
    api.inbox(params).then((d) => live && setData(d)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [params, openItem]);

  const set = (patch: Filters) => setFilters({ ...filters, ...patch });

  const statusSet = new Set((filters.status ?? '').split(',').filter(Boolean));
  const toggleStatus = (key: string) => {
    const next = new Set(statusSet);
    next.has(key) ? next.delete(key) : next.add(key);
    set({ status: [...next].join(',') });
  };
  const toggleOverlay = (key: string) => set({ [key]: filters[key] === 'true' ? '' : 'true' });

  const activeCount = Object.entries(filters).filter(([k, v]) => v && k !== 'source' && k !== 'view').length;

  return (
    <>
      <div className="header">
        <div>
          <h1>{title}</h1>
          <div className="subtitle">{subtitle}</div>
        </div>
        <div className="muted">{data ? `${data.total} of ${data.facets.total}` : ''}</div>
      </div>

      <div className="tabs">
        {CHANNELS.map((c) => (
          <button
            key={c.key}
            className={`tab ${(filters.source ?? 'gmail') === c.key ? 'active' : ''}`}
            disabled={!c.ready}
            title={c.ready ? undefined : `${c.label} ingestion is not built yet`}
            onClick={() => set({ source: c.key })}
          >
            {c.label}{!c.ready && <span className="tag" style={{ marginLeft: 6 }}>soon</span>}
          </button>
        ))}
      </div>

      <div className="chips">
        {STATUSES.map((s) => {
          const n = data?.facets.status[s.key] ?? 0;
          return (
            <button key={s.key} className={`chip ${statusSet.has(s.key) ? 'on' : ''}`} onClick={() => toggleStatus(s.key)}>
              {s.label} <span className="chip-n">{n}</span>
            </button>
          );
        })}
        <span className="chip-sep" />
        {OVERLAYS.map((o) => (
          <button key={o.key} className={`chip ${filters[o.key] === 'true' ? 'on' : ''}`} onClick={() => toggleOverlay(o.key)}>
            {o.label} <span className="chip-n">{data?.facets[o.facet] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="toolbar">
        <select value={filters.clientId ?? ''} onChange={(e) => set({ clientId: e.target.value })}>
          <option value="">All clients</option>
          {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select value={filters.teamId ?? ''} onChange={(e) => set({ teamId: e.target.value })}>
          <option value="">All teams</option>
          {teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
        <select value={filters.ownerUserId ?? ''} onChange={(e) => set({ ownerUserId: e.target.value })}>
          <option value="">Any owner</option>
          {users.map((u) => <option key={u.id} value={u.id}>{u.email}</option>)}
        </select>
        <select value={filters.age ?? ''} onChange={(e) => set({ age: e.target.value })}>
          <option value="">Any age</option>
          <option value="4h">Under 4h</option>
          <option value="24h">4–24h</option>
          <option value="3d">1–3 days</option>
          <option value="older">Over 3 days</option>
        </select>
        <select value={filters.priority ?? ''} onChange={(e) => set({ priority: e.target.value })}>
          <option value="">Any priority</option>
          <option value="high">High</option>
          <option value="normal">Normal</option>
          <option value="low">Low</option>
        </select>
        <input
          type="search"
          className="toolbar-search"
          placeholder="Search subject…"
          value={filters.search ?? ''}
          onChange={(e) => set({ search: e.target.value })}
        />

        {activeCount > 0 && (
          <>
            <button className="btn small" onClick={() => setFilters({ source: filters.source ?? 'gmail', view: filters.view ?? 'all' })}>
              Clear {activeCount}
            </button>
            <button
              className="btn small"
              disabled={saving}
              onClick={async () => {
                const name = window.prompt('Name this view');
                if (!name) return;
                setSaving(true);
                try { await api.createSavedView(name, filters); window.dispatchEvent(new Event('rq:views-changed')); }
                finally { setSaving(false); }
              }}
            >
              Save view
            </button>
          </>
        )}
      </div>

      {error && <div className="banner danger">{error}</div>}

      <div className="card list">
        {!data && !error && <div className="empty">Loading…</div>}
        {data?.items.length === 0 && <div className="empty">Nothing matches these filters.</div>}
        {data?.items.map((it) => (
          <div key={it.id} className={`row ${openItem === it.id ? 'selected' : ''}`} onClick={() => onOpen(it.id)}>
            <div className="row-title">
              <StateDot state={it.state} />
              {it.subject}
              {it.priority === 'high' && <span className="tag high">high</span>}
              {it.overdue && <span className="tag overdue">overdue</span>}
              {it.lowConfidence && <span className="tag low-conf">low confidence</span>}
              {it.muted && <span className="tag">muted</span>}
              {it.filterReason && <span className="tag">{it.filterReason}</span>}
            </div>
            <div className="row-right">
              {timeAgo(it.lastExternalAt)}
              {it.slaDueAt && it.state === 'needs_reply' && <div style={{ fontSize: 11 }}>{formatDue(it.slaDueAt)}</div>}
              {it.snoozedUntil && <div style={{ fontSize: 11 }}>wakes {new Date(it.snoozedUntil).toLocaleDateString()}</div>}
            </div>
            <div className="row-meta">
              <span className={`tag ${it.clientName ? 'client' : ''}`}>{it.clientName ?? 'unmatched'}</span>
              {it.teamName && <span className="tag">{it.teamName}</span>}
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

const STATE_COLOR: Record<string, string> = {
  needs_reply: 'var(--danger)',
  sending: 'var(--warn)',
  replied: 'var(--ok)',
  fyi: 'var(--muted)',
  snoozed: 'var(--accent)',
  ignored: 'var(--muted)',
  auto_ignored: 'var(--border)',
  handled_elsewhere: 'var(--ok)',
};

function StateDot({ state }: { state: string }) {
  return <span className="state-dot" title={state.replace(/_/g, ' ')} style={{ background: STATE_COLOR[state] ?? 'var(--muted)' }} />;
}
