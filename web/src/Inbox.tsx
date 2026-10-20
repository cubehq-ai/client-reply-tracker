import { useEffect, useMemo, useState } from 'react';
import { api, timeAgo, type InboxFacets, type QueueItem, type User } from './api';
import { MultiSelect } from './MultiSelect';

/** Channel tabs. Slack is ready only once a token is configured. */
const CHANNELS = [
  { key: 'gmail', label: 'Email' },
  { key: 'slack', label: 'Slack' },
];

/** Why a closed item is closed. Only meaningful on the second tab. */
const REASONS = [
  { key: 'replied', label: 'Replied' },
  { key: 'not_needed', label: 'No reply needed' },
  { key: 'filtered', label: 'Filtered' },
  { key: 'ignored', label: 'Ignored' },
];

/** Flags on an item, not states: each narrows the current tab. */
const FLAGS: { key: string; label: string; facet: 'unmatched' | 'lowConfidence'; tab: string }[] = [
  { key: 'unmatched', label: 'Unmatched client', facet: 'unmatched', tab: 'both' },
  { key: 'lowConfidence', label: 'Low confidence', facet: 'lowConfidence', tab: 'both' },
];

export type Filters = Record<string, string>;

export function Inbox({ user, filters, setFilters, clients, users, teams, onOpen, openItem, title, subtitle, refreshKey, classifier }: {
  user: User; filters: Filters; setFilters: (f: Filters) => void;
  clients: any[]; users: any[]; teams: any[];
  onOpen: (id: number, source?: 'gmail' | 'slack') => void; openItem: number | null;
  title: string; subtitle: string;
  /** Bumped only when something actually changed; opening an item does not. */
  refreshKey: number;
  /** 'heuristic' or 'anthropic' — decides whether a confidence score means anything. */
  classifier: string;
}) {
  const [data, setData] = useState<{ items: QueueItem[]; total: number; facets: InboxFacets } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slack, setSlack] = useState<{ connected: boolean; postingAs: { userName: string } | null } | null>(null);
  const [channels, setChannels] = useState<{ id: string; name: string; watched: boolean }[]>([]);

  useEffect(() => {
    api.slackStatus().then(setSlack).catch(() => setSlack({ connected: false, postingAs: null }));
    api.slackChannels().then((r) => setChannels(r.channels)).catch(() => setChannels([]));
  }, [refreshKey]);

  const params = useMemo(() => {
    const p: Filters = { limit: '100', ...filters };
    if (!p.source) p.source = 'gmail';
    if (!p.tab) p.tab = 'needs_reply';
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
  const tab = filters.tab === 'no_reply_needed' ? 'no_reply_needed' : 'needs_reply';
  const reasonSet = new Set((filters.reasons ?? '').split(',').filter(Boolean));
  const toggleReason = (key: string) => {
    const next = new Set(reasonSet);
    next.has(key) ? next.delete(key) : next.add(key);
    set({ reasons: [...next].join(',') });
  };
  const toggleFlag = (key: string) => set({ [key]: filters[key] === 'true' ? '' : 'true' });

  const activeCount = Object.entries(filters)
    .filter(([k, v]) => v && !['source', 'view', 'tab', 'reasons', 'freshness'].includes(k)).length;

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
        {CHANNELS.map((c) => {
          const ready = c.key !== 'slack' || slack?.connected === true;
          return (
            <button
              key={c.key}
              className={`tab ${(filters.source ?? 'gmail') === c.key ? 'active' : ''}`}
              disabled={!ready}
              title={ready ? undefined : 'Set SLACK_USER_TOKEN to connect Slack'}
              onClick={() => set({ source: c.key, channelIds: '' })}
            >
              {c.label}
              {!ready && <span className="tag" style={{ marginLeft: 6 }}>not connected</span>}
            </button>
          );
        })}
      </div>

      <div className="tabs state-tabs">
        <button
          className={`tab ${tab === 'needs_reply' ? 'active' : ''}`}
          onClick={() => set({ tab: 'needs_reply', reasons: '' })}
        >
          Needs reply <span className="tab-n">{data?.facets.needsReply ?? 0}</span>
        </button>
        <button
          className={`tab ${tab === 'no_reply_needed' ? 'active' : ''}`}
          onClick={() => set({ tab: 'no_reply_needed', overdue: '' })}
        >
          No reply needed <span className="tab-n">{data?.facets.noReplyNeeded ?? 0}</span>
        </button>
      </div>

      <div className="chips">
        {tab === 'needs_reply' ? (
          <>
            <button
              className={`chip ${filters.freshness === 'aged' ? 'on' : ''}`}
              title={`Waiting more than ${hours} hours`}
              onClick={() => set({ freshness: filters.freshness === 'aged' ? '' : 'aged' })}
            >
              Waiting {hours}h+ <span className="chip-n">{data?.facets.notReplied ?? 0}</span>
            </button>
            <button
              className={`chip ${filters.freshness === 'fresh' ? 'on' : ''}`}
              title={`Arrived in the last ${hours} hours`}
              onClick={() => set({ freshness: filters.freshness === 'fresh' ? '' : 'fresh' })}
            >
              Recent (&lt;{hours}h) <span className="chip-n">{data?.facets.fresh ?? 0}</span>
            </button>
            <span className="chip-sep" />
          </>
        ) : (
          <>
            {REASONS.map((r) => {
              const on = reasonSet.has(r.key);
              return (
                <button key={r.key} className={`chip ${on ? 'on' : ''}`} onClick={() => toggleReason(r.key)}>
                  {r.label} <span className="chip-n">{data?.facets.reasons[r.key] ?? 0}</span>
                </button>
              );
            })}
            <span className="chip-sep" />
          </>
        )}

        {FLAGS.filter((f) => f.tab === 'both' || f.tab === tab).map((f) => (
          <button key={f.key} className={`chip ${filters[f.key] === 'true' ? 'on' : ''}`} onClick={() => toggleFlag(f.key)}>
            {f.label} <span className="chip-n">{data?.facets[f.facet] ?? 0}</span>
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
          {filters.source === 'slack' && (
            <MultiSelect
              label="Channel"
              searchable
              options={channels.filter((c) => c.watched).map((c) => ({ value: c.id, label: `#${c.name}` }))}
              selected={list(filters.channelIds)}
              onChange={(v) => set({ channelIds: v.join(',') })}
            />
          )}
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
          <div key={it.id} className={`row ${openItem === it.id ? 'selected' : ''}`} onClick={() => onOpen(it.id, it.source)}>
            <div className="row-title">
              <StateDot state={it.state} />
              {it.source === 'slack' && it.slackChannelName ? `#${it.slackChannelName}` : it.subject}
              {it.muted && <span className="tag">muted</span>}
              {it.reason && <span className="tag">{REASONS.find((r) => r.key === it.reason)?.label ?? it.reason}</span>}
              {it.filterReason && <span className="tag">{it.filterReason}</span>}
              {it.lowConfidence && classifier !== 'heuristic' && <span className="tag low-conf">low confidence</span>}
            </div>
            <div className="row-right">
              {timeAgo(it.lastExternalAt)}

            </div>
            <div className="row-meta">
              <span className={`tag ${it.clientName ? 'client' : ''}`}>{it.clientName ?? 'unmatched'}</span>
              {it.teamName && <span className="tag">{it.teamName}</span>}
              <span>{it.source === 'slack' ? (it.fromName ?? it.fromEmail) : it.fromEmail}</span>
              <span>owner: {it.ownerEmail ?? 'unowned'}</span>

              {(it.source === 'slack' ? (it.snippet ?? it.summary) : it.summary) && (
                <span style={{ flexBasis: '100%' }}>
                  {it.source === 'slack' ? (it.snippet ?? it.summary) : it.summary}
                </span>
              )}
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
