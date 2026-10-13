import { useEffect, useMemo, useState } from 'react';
import { api, formatDue, timeAgo, type InboxFacets, type QueueItem, type User } from './api';
import { MultiSelect } from './MultiSelect';

/** Channel tabs. Email is v1; Slack is the planned second source (SPEC 15). */
const CHANNELS = [
  { key: 'gmail', label: 'Email', ready: true },
  { key: 'slack', label: 'Slack', ready: false },
];

const STATUSES = [
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
  { key: 'awaitingClient', label: 'Awaiting client', facet: 'awaitingClient' as const },
];

export type Filters = Record<string, string>;

export function Inbox({ user, filters, setFilters, clients, users, teams, onOpen, openItem, title, subtitle, refreshKey, classifier }: {
  user: User; filters: Filters; setFilters: (f: Filters) => void;
  clients: any[]; users: any[]; teams: any[];
  onOpen: (id: number) => void; openItem: number | null;
  title: string; subtitle: string;
  /** Bumped only when something actually changed; opening an item does not. */
  refreshKey: number;
  /** 'heuristic' or 'anthropic' — decides whether a confidence score means anything. */
  classifier: string;
}) {
  const [data, setData] = useState<{ items: QueueItem[]; total: number; facets: InboxFacets } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const params = useMemo(() => {
    const p: Filters = { limit: '100', ...filters };
    if (!p.source) p.source = 'gmail';
    return p;
  }, [filters]);

  useEffect(() => {
    let live = true;
    // Keep the current rows on screen while refetching, so the list does not
    // blank out and jump every time something changes.
    setError(null);
    api.inbox(params).then((d) => live && setData(d)).catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [params, refreshKey]);

  const set = (patch: Filters) => setFilters({ ...filters, ...patch });

  const hours = data?.facets.thresholdHours ?? 12;
  /** Comma-separated filter value -> array, for the multi-selects. */
  const list = (v?: string): string[] => (v ? v.split(',').filter(Boolean) : []);
  const statusSet = new Set((filters.status ?? '').split(',').filter(Boolean));
  const toggleStatus = (key: string) => {
    const next = new Set(statusSet);
    next.has(key) ? next.delete(key) : next.add(key);
    set({ status: [...next].join(','), freshness: '' });
  };
  const toggleOverlay = (key: string) => set({ [key]: filters[key] === 'true' ? '' : 'true' });

  const activeCount = Object.entries(filters).filter(([k, v]) => v && k !== 'source' && k !== 'view' && k !== 'status' && k !== 'freshness').length;

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
        <button
          className={`chip ${filters.freshness === 'aged' ? 'on' : ''}`}
          title={`Client wrote more than ${hours}h ago and nobody has replied`}
          onClick={() => set({ status: 'needs_reply', freshness: filters.freshness === 'aged' ? '' : 'aged' })}
        >
          Not replied ({hours}h+) <span className="chip-n">{data?.facets.notReplied ?? 0}</span>
        </button>
        <button
          className={`chip ${filters.freshness === 'fresh' ? 'on' : ''}`}
          title={`Waiting on us, but less than ${hours}h old`}
          onClick={() => set({ status: 'needs_reply', freshness: filters.freshness === 'fresh' ? '' : 'fresh' })}
        >
          Awaiting (&lt;{hours}h) <span className="chip-n">{data?.facets.fresh ?? 0}</span>
        </button>
        <span className="chip-sep" />
        {STATUSES.map((s) => {
          const n = data?.facets.status[s.key] ?? 0;
          return (
            <button key={s.key} className={`chip ${statusSet.has(s.key) ? 'on' : ''}`} onClick={() => toggleStatus(s.key)}>
              {s.label} <span className="chip-n">{n}</span>
            </button>
          );
        })}
        <span className="chip-sep" />
        {classifier !== 'heuristic' && (
          <button className={`chip ${filters.lowConfidence === 'true' ? 'on' : ''}`} onClick={() => toggleOverlay('lowConfidence')}>
            Low confidence <span className="chip-n">{data?.facets.lowConfidence ?? 0}</span>
          </button>
        )}
        {OVERLAYS.map((o) => (
          <button key={o.key} className={`chip ${filters[o.key] === 'true' ? 'on' : ''}`} onClick={() => toggleOverlay(o.key)}>
            {o.label} <span className="chip-n">{data?.facets[o.facet] ?? 0}</span>
          </button>
        ))}
      </div>

      <div className="toolbar split">
        <div className="toolbar-filters">
          <MultiSelect
            label="Client"
            searchable
            options={clients.map((c) => ({ value: String(c.id), label: c.name }))}
            selected={list(filters.clientIds)}
            onChange={(v) => set({ clientIds: v.join(',') })}
          />
          <MultiSelect
            label="Team"
            options={teams.map((t) => ({ value: String(t.id), label: t.name }))}
            selected={list(filters.teamIds)}
            onChange={(v) => set({ teamIds: v.join(',') })}
          />
          <MultiSelect
            label="Recipient"
            searchable
            options={users.map((u) => ({ value: String(u.id), label: u.email }))}
            selected={list(filters.ownerUserIds)}
            onChange={(v) => set({ ownerUserIds: v.join(',') })}
          />
          <MultiSelect
            label="Age"
            options={[
              { value: '4h', label: 'Under 4 hours' },
              { value: '24h', label: '4 to 24 hours' },
              { value: '3d', label: '1 to 3 days' },
              { value: 'older', label: 'Over 3 days' },
            ]}
            selected={list(filters.ages)}
            onChange={(v) => set({ ages: v.join(',') })}
          />
          <MultiSelect
            label="Priority"
            options={[
              { value: 'high', label: 'High' },
              { value: 'normal', label: 'Normal' },
              { value: 'low', label: 'Low' },
            ]}
            selected={list(filters.priorities)}
            onChange={(v) => set({ priorities: v.join(',') })}
          />
        </div>

        <div className="toolbar-actions">
          <div className="search-wrap">
            <svg className="search-icon" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path d="M10.5 10.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
            <input
              type="search"
              className="toolbar-search"
              placeholder="Search subjects and summaries…"
              value={filters.search ?? ''}
              onChange={(e) => set({ search: e.target.value })}
            />
            {filters.search && (
              <button className="search-clear" onClick={() => set({ search: '' })} title="Clear search">×</button>
            )}
          </div>
          {activeCount > 0 && (
            <button
              className="btn small"
              onClick={() => setFilters({ source: filters.source ?? 'gmail', view: filters.view ?? 'all' })}
            >
              Clear {activeCount}
            </button>
          )}
        </div>
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
