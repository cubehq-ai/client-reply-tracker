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

/**
 * Flags on an item, not states: each narrows the current tab.
 *
 * Low confidence is Slack-only. On mail the classifier is rules-based, so
 * the flag was set on a large share of the queue and narrowed nothing a
 * reader could act on.
 */
const FLAGS: { key: string; label: string; facet: 'unmatched' | 'lowConfidence'; sources: string[] }[] = [
  { key: 'unmatched', label: 'Unmatched client', facet: 'unmatched', sources: ['gmail', 'slack'] },
  { key: 'lowConfidence', label: 'Low confidence', facet: 'lowConfidence', sources: ['slack'] },
];

export type Filters = Record<string, string>;

/**
 * The waiting filter is on from the start, at 12 hours.
 *
 * It used to render "12" while sending no threshold at all, so the control
 * claimed to be filtering, its count came from 12 hours, and the list below
 * it showed everything -- three numbers, two of which disagreed. Sending the
 * default explicitly makes the control, its count and the list one thing.
 */
const DEFAULT_WAIT_HOURS = '12';

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
    if (!p.waitHours) p.waitHours = DEFAULT_WAIT_HOURS;
    if (!p.waitOp) p.waitOp = 'gt';
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
  const tab = filters.tab === 'no_reply_needed' || filters.tab === 'all' ? filters.tab : 'needs_reply';
  const reasonSet = new Set((filters.reasons ?? '').split(',').filter(Boolean));
  const toggleReason = (key: string) => {
    const next = new Set(reasonSet);
    next.has(key) ? next.delete(key) : next.add(key);
    set({ reasons: [...next].join(',') });
  };
  const toggleFlag = (key: string) => set({ [key]: filters[key] === 'true' ? '' : 'true' });

  const activeCount = Object.entries(filters)
    .filter(([k, v]) => v && !['source', 'view', 'tab', 'reasons', 'waitHours', 'waitOp'].includes(k)).length;

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
        <button
          className={`tab ${tab === 'all' ? 'active' : ''}`}
          title="Both tabs together"
          onClick={() => set({ tab: 'all', overdue: '' })}
        >
          All <span className="tab-n">{data?.facets.total ?? 0}</span>
        </button>
      </div>

      <div className="chips">
        {(tab === 'no_reply_needed' || tab === 'all') && (
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

        {FLAGS.filter((f) => f.sources.includes(filters.source ?? 'gmail')).map((f) => (
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
          <WaitFilter
            hours={filters.waitHours ?? DEFAULT_WAIT_HOURS}
            op={filters.waitOp === 'lt' ? 'lt' : 'gt'}
            counts={{ gt: data?.facets.notReplied ?? 0, lt: data?.facets.fresh ?? 0 }}
            onChange={(next) => set(next)}
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
              {it.source === 'slack' && it.pendingCount > 1 && (
                <span className="tag">{it.pendingCount} waiting</span>
              )}
              {it.muted && <span className="tag">muted</span>}
              {it.reason && <span className="tag">{REASONS.find((r) => r.key === it.reason)?.label ?? it.reason}</span>}
              {it.filterReason && <span className="tag">{it.filterReason}</span>}
              {it.lowConfidence && classifier !== 'heuristic' && <span className="tag low-conf">low confidence</span>}
            </div>
            <div className="row-right">
              {/* A channel is judged by how long the oldest unanswered
                  message has waited, not by its last activity. */}
              {timeAgo(it.source === 'slack' ? (it.oldestPendingAt ?? it.lastActivityAt) : it.lastExternalAt)}
            </div>
            <div className="row-meta">
              <span className={`tag ${it.clientName ? 'client' : ''}`}>{it.clientName ?? 'unmatched'}</span>
              {it.teamName && <span className="tag">{it.teamName}</span>}
              <span>{it.source === 'slack' ? (it.fromName ?? it.fromEmail) : it.fromEmail}</span>
              {/* Who was written to, not who the item happens to be filed
                  under: a mail to one person copying five has one owner, and
                  naming the To line is what a reader is looking for. */}
              {(it.addressedTo?.length ? it.addressedTo : it.ownerEmail ? [it.ownerEmail] : []).length > 0 && (
                <span title={(it.addressedTo ?? []).join(', ')}>
                  to: {formatRecipients(it.addressedTo?.length ? it.addressedTo : [it.ownerEmail!])}
                </span>
              )}

              {(it.source === 'slack' ? (it.preview ?? it.snippet) : it.summary) && (
                <span style={{ flexBasis: '100%' }}>
                  {it.source === 'slack' ? (it.preview ?? it.snippet) : it.summary}
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

/**
 * How long something has been waiting, as one control.
 *
 * It replaced two fixed 12h chips and a bucket list of 4h/24h/3d/older --
 * three controls over the same column, whose counts disagreed and none of
 * which could answer "more than six hours". Direction plus an hour, and the
 * hour is the reader's to set.
 */
function WaitFilter({ hours, op, counts, onChange }: {
  hours: string;
  op: 'gt' | 'lt';
  counts: { gt: number; lt: number };
  onChange: (next: Record<string, string>) => void;
}) {
  const n = Number(hours) || 0;
  const step = (by: number): void => {
    onChange({ waitHours: String(Math.max(1, Math.min(8760, n + by))) });
  };
  return (
    <div className="wait-filter" title="How long the client has been waiting">
      {/* The same chevron the multi-selects use, drawn rather than left to
          the browser: a bare select inside a grouped control shows no arrow
          on some platforms, and the second option was invisible until you
          clicked. */}
      <span className="wait-seg wait-dir">
        <select value={op} onChange={(e) => onChange({ waitOp: e.target.value })}>
          <option value="gt">Waiting over</option>
          <option value="lt">Waiting under</option>
        </select>
        <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden="true" className="wait-caret">
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      <span className="wait-seg wait-hours">
        <button className="wait-step" onClick={() => step(-1)} aria-label="one hour less">−</button>
        <input
          type="number"
          min={1}
          max={8760}
          value={hours}
          aria-label="hours waited"
          onChange={(e) => onChange({ waitHours: e.target.value })}
        />
        <span className="wait-unit">h</span>
        <button className="wait-step" onClick={() => step(1)} aria-label="one hour more">+</button>
      </span>
      <span className="wait-seg wait-count">{op === 'gt' ? counts.gt : counts.lt} items</span>
    </div>
  );
}

/** Two names, then a count: a long To line should not take over the row. */
function formatRecipients(emails: string[]): string {
  const names = emails.map((e) => e.split('@')[0] ?? e);
  if (names.length <= 2) return names.join(', ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

function StateDot({ state }: { state: string }) {
  return <span className="state-dot" title={state.replace(/_/g, ' ')} style={{ background: STATE_COLOR[state] ?? 'var(--muted)' }} />;
}
