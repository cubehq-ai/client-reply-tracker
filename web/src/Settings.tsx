import { useEffect, useState } from 'react';
import { api, timeAgo } from './api';
import { Rules } from './Rules';

/** Tolerates a scalar, a Postgres array literal, or a real array. */
function toList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') {
    const inner = value.replace(/^\{|\}$/g, '').trim();
    return inner ? inner.split(',').map((v) => v.replace(/^"|"$/g, '').trim()).filter(Boolean) : [];
  }
  return [];
}

const TABS = [
  { key: 'mailboxes', label: 'Mailboxes & teams' },
  { key: 'clients', label: 'Clients & domains' },
  { key: 'rules', label: 'Matching rules' },
];

export function Settings({ onChanged, clients }: { onChanged: () => void; clients: any[] }) {
  const [tab, setTab] = useState('mailboxes');
  return (
    <>
      <div className="header"><div><h1>Settings</h1><div className="subtitle">Who we watch, who the clients are, and what gets filtered.</div></div></div>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>{t.label}</button>
        ))}
      </div>
      {tab === 'mailboxes' && <Mailboxes onChanged={onChanged} />}
      {tab === 'clients' && <Clients onChanged={onChanged} />}
      {tab === 'rules' && <Rules clients={clients} onChanged={onChanged} />}
    </>
  );
}

function Mailboxes({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<{ mailboxes: any[]; teams: any[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Which section has its inline "add" row open. */
  const [adding, setAdding] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const [unwatched, setUnwatched] = useState<any[]>([]);

  const load = () => Promise.all([
    api.settingsMailboxes().then(setData),
    api.unwatched().then((r) => setUnwatched(r.people ?? [])).catch(() => setUnwatched([])),
  ]).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  async function act(fn: () => Promise<any>, msg: string) {
    setError(null);
    try { await fn(); setNotice(msg); await load(); onChanged(); }
    catch (e: any) { setError(e.message); }
  }

  function closeAdd() { setAdding(null); setDraft(''); }

  if (!data) return <div className="empty">{error ?? 'Loading…'}</div>;

  // Every team gets a section, including an empty one, so a mailbox can always
  // be added straight into the team it belongs to.
  const byTeam = new Map<string, any[]>();
  for (const t of data.teams) byTeam.set(t.name, []);
  for (const m of data.mailboxes) {
    const key = m.team_name ?? 'No team';
    byTeam.set(key, [...(byTeam.get(key) ?? []), m]);
  }

  return (
    <>
      {notice && <div className="banner info">{notice}</div>}
      {error && <div className="banner danger">{error}</div>}

      {unwatched.length > 0 && (
        <div className="card" style={{ marginBottom: 14 }}>
          <div className="section-title">
            <span>
              In the dashboard, not being watched <span className="muted">· {unwatched.length}</span>
            </span>
            <button className="btn small" onClick={() => act(async () => {
              const res = await api.settingsPost('mailboxes', { emails: unwatched.map((p) => p.email) });
              setNotice(`Added ${res.added?.length ?? 0} mailbox(es).`);
            }, 'Added to the watch list.')}>
              Add all
            </button>
          </div>
          <div className="muted" style={{ padding: '10px 14px 0', fontSize: 12.5 }}>
            New people appear here rather than being watched automatically — reading someone's
            mailbox should be a decision, not a side effect of a sync.
          </div>
          <table>
            <thead><tr><th>Person</th><th>Role</th><th></th></tr></thead>
            <tbody>
              {unwatched.map((p) => (
                <tr key={p.email}>
                  <td className="mono">{p.email}{p.name ? ` · ${p.name}` : ''}</td>
                  <td>{p.role ?? '—'}</td>
                  <td>
                    <button className="btn small" onClick={() => act(
                      () => api.settingsPost('mailboxes', { email: p.email, team: p.role }),
                      `${p.email} added.`,
                    )}>Watch</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="section-title">
          <span>Teams</span>
          <span className="section-actions">
            <button className="btn small" onClick={() => { setAdding(adding === '__team' ? null : '__team'); setDraft(''); }}>
              {adding === '__team' ? 'Cancel' : '+ Add team'}
            </button>
            <button className="btn small" onClick={() => act(async () => {
              const r = await api.settingsPost('sync-teams');
              setNotice(`Teams synced: ${r.assigned} mailbox(es) assigned, ${r.notWatched?.length ?? 0} not watched.`);
            }, 'Teams synced from the dashboard.')}>
              Sync from dashboard
            </button>
          </span>
        </div>

        {adding === '__team' && (
          <div className="inline-add">
            <input
              type="text" autoFocus placeholder="Team name" value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) { void act(() => api.settingsPost('teams', { name: draft }), 'Team created.').then(closeAdd); } }}
            />
            <button className="btn primary small" disabled={!draft.trim()}
              onClick={() => act(() => api.settingsPost('teams', { name: draft }), 'Team created.').then(closeAdd)}>
              Add team
            </button>
          </div>
        )}

        <table>
          <thead><tr><th>Team</th><th className="num">Members</th><th className="num">Mailboxes</th><th></th></tr></thead>
          <tbody>
            {data.teams.length === 0 && <tr><td colSpan={4} className="muted">No teams yet.</td></tr>}
            {data.teams.map((t) => (
              <tr key={t.id}>
                <td><strong>{t.name}</strong></td>
                <td className="num">{t.members}</td>
                <td className="num">{t.mailboxes}</td>
                <td>
                  <button className="btn small" onClick={() => {
                    const name = window.prompt('Rename team', t.name);
                    if (name) void act(() => api.settingsPatch(`teams/${t.id}`, { name }), 'Team renamed.');
                  }}>Rename</button>
                  <button className="btn small danger" style={{ marginLeft: 6 }} onClick={() => {
                    if (window.confirm(`Delete team "${t.name}"? Members keep their mailboxes but lose the team.`)) {
                      void act(() => api.settingsDelete(`teams/${t.id}`), 'Team deleted.');
                    }
                  }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {[...byTeam.entries()].map(([team, boxes]) => (
        <div className="card" style={{ marginBottom: 14 }} key={team}>
          <div className="section-title">
            <span>{team} <span className="muted">· {boxes.length}</span></span>
            <button className="btn small" onClick={() => { setAdding(adding === team ? null : team); setDraft(''); }}>
              {adding === team ? 'Cancel' : '+ Add mailbox'}
            </button>
          </div>

          {adding === team && (
            <div className="inline-add">
              <input
                type="text" autoFocus style={{ minWidth: 320 }}
                placeholder="name@cubehq.ai — or several, comma or newline separated"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim()) void submitMailboxes(); }}
              />
              <button className="btn primary small" disabled={!draft.trim()} onClick={() => void submitMailboxes()}>
                Add to {team === 'No team' ? 'watch list' : team}
              </button>
            </div>
          )}

          <table>
            <thead><tr><th>Mailbox</th><th>Kind</th><th>Status</th><th className="num">Messages</th><th>Last synced</th><th></th></tr></thead>
            <tbody>
              {boxes.length === 0 && <tr><td colSpan={6} className="muted">No mailboxes in this team yet.</td></tr>}
              {boxes.map((m) => (
                <tr key={m.id}>
                  <td className="mono">{m.email}</td>
                  <td>{m.kind}</td>
                  <td>
                    <select value={m.status} onChange={(e) => act(() => api.settingsPatch(`mailboxes/${m.id}`, { status: e.target.value }), 'Updated.')}>
                      <option value="active">active</option>
                      <option value="paused">paused</option>
                      <option value="excluded">excluded</option>
                    </select>
                  </td>
                  <td className="num">{m.message_count}</td>
                  <td className="muted">{timeAgo(m.last_synced_at)}</td>
                  <td>
                    <input
                      type="text" list="team-list" defaultValue={m.team_name ?? ''} placeholder="team"
                      style={{ width: 110 }}
                      onBlur={(e) => {
                        const v = e.target.value.trim();
                        if (v !== (m.team_name ?? '')) void act(() => api.settingsPatch(`mailboxes/${m.id}`, { team: v || null }), 'Team updated.');
                      }}
                    />
                    <button className="btn small danger" style={{ marginLeft: 6 }} onClick={() => {
                      if (window.confirm(`Stop watching ${m.email}? History is kept.`)) {
                        void act(() => api.settingsDelete(`mailboxes/${m.id}`), 'Removed from the watch list.');
                      }
                    }}>Remove</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <datalist id="team-list">{data.teams.map((t) => <option key={t.id} value={t.name} />)}</datalist>
    </>
  );

  async function submitMailboxes() {
    const team = adding === 'No team' ? null : adding;
    const emails = draft.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean);
    if (emails.length === 0) return;
    await act(async () => {
      const res = await api.settingsPost('mailboxes', { emails, team });
      if (res.rejected?.length) {
        setError(`Rejected: ${res.rejected.map((r: any) => `${r.email} (${r.reason})`).join(', ')}`);
      }
    }, emails.length === 1 ? 'Mailbox added.' : `${emails.length} mailboxes added.`);
    closeAdd();
  }
}

function Clients({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<{ clients: any[]; unmatched: any[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newClient, setNewClient] = useState({ name: '', domains: '' });
  const [patternTest, setPatternTest] = useState<{ pattern: string; result: any } | null>(null);

  const load = () => api.settingsClients().then(setData).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  async function act(fn: () => Promise<any>, msg: string) {
    setError(null);
    try { await fn(); setNotice(msg); await load(); onChanged(); }
    catch (e: any) { setError(e.message); }
  }

  if (!data) return <div className="empty">{error ?? 'Loading…'}</div>;

  return (
    <>
      {notice && <div className="banner info">{notice}</div>}
      {error && <div className="banner danger">{error}</div>}

      <div className="banner info">
        Client matching is a lookup table plus explicit regexes — no model is involved.
        A sender matches by exact address, then regex pattern, then domain, then subdomain.
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="section-title">
          <span>Unmatched senders <span className="muted">· link these to a client</span></span>
          {data.unmatched.some((u: any) => u.suggestion) && (
            <button className="btn small primary" onClick={() => act(async () => {
              const res = await api.settingsPost('apply-suggestions');
              setNotice(`Linked ${res.linked.length} domain(s).`);
            }, 'Suggestions applied.')}>
              Apply {new Set(data.unmatched.filter((u: any) => u.suggestion).map((u: any) => u.from_domain)).size} suggestion(s)
            </button>
          )}
        </div>
        <table>
          <thead><tr><th>Sender</th><th>Domain</th><th className="num">Items</th><th>Last seen</th><th>Suggested</th><th>Link to</th></tr></thead>
          <tbody>
            {data.unmatched.length === 0 && <tr><td colSpan={6} className="muted">Nothing unmatched.</td></tr>}
            {data.unmatched.map((u) => (
              <tr key={u.from_email}>
                <td className="mono">{u.from_email}</td>
                <td className="mono muted">{u.from_domain}</td>
                <td className="num">{u.items}</td>
                <td className="muted">{timeAgo(u.last_seen)}</td>
                <td>
                  {u.suggestion ? (
                    <button
                      className="btn small primary"
                      title={`Link ${u.from_domain} to ${u.suggestion.name}`}
                      onClick={() => act(() => api.settingsPost(`clients/${u.suggestion.id}/domains`, { domain: u.from_domain }), 'Linked.')}
                    >
                      {u.suggestion.name}
                    </button>
                  ) : <span className="muted">—</span>}
                </td>
                <td>
                  <select defaultValue="" onChange={(e) => {
                    if (!e.target.value) return;
                    const [clientId, mode] = e.target.value.split(':');
                    void act(async () => {
                      if (mode === 'domain') await api.settingsPost(`clients/${clientId}/domains`, { domain: u.from_domain });
                      else await api.settingsPost(`clients/${clientId}/patterns`, { pattern: `^${u.from_email.replace(/[.+]/g, '\\$&')}$`, priority: 50, note: 'linked from Unmatched' });
                    }, 'Linked.');
                  }}>
                    <option value="">Choose…</option>
                    {data.clients.map((c) => (
                      <optgroup key={c.id} label={c.name}>
                        <option value={`${c.id}:domain`}>{c.name} — whole domain {u.from_domain}</option>
                        <option value={`${c.id}:email`}>{c.name} — this address only</option>
                      </optgroup>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="section-title">Add a client</div>
        <div className="toolbar" style={{ padding: 12, marginBottom: 0 }}>
          <input type="text" placeholder="Client name" value={newClient.name} onChange={(e) => setNewClient({ ...newClient, name: e.target.value })} />
          <input type="text" placeholder="domains, comma separated" style={{ minWidth: 240 }} value={newClient.domains} onChange={(e) => setNewClient({ ...newClient, domains: e.target.value })} />
          <button className="btn primary" disabled={!newClient.name.trim()} onClick={() => act(async () => {
            const res = await api.settingsPost('clients', {
              name: newClient.name,
              domains: newClient.domains.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean),
            });
            setNewClient({ name: '', domains: '' });
            if (res.rejectedDomains?.length) setError(`Rejected domains: ${res.rejectedDomains.join(', ')}`);
          }, 'Client added.')}>Add client</button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="section-title">Test a regex against unmatched senders</div>
        <div className="toolbar" style={{ padding: 12, marginBottom: 0 }}>
          <input
            type="text" className="mono" style={{ minWidth: 300 }} placeholder="^.*\.acme@agency\.example$"
            value={patternTest?.pattern ?? ''}
            onChange={(e) => setPatternTest({ pattern: e.target.value, result: null })}
          />
          <button className="btn" disabled={!patternTest?.pattern} onClick={async () => {
            const result = await api.settingsPost('test-pattern', { pattern: patternTest!.pattern });
            setPatternTest({ pattern: patternTest!.pattern, result });
          }}>Test</button>
        </div>
        {patternTest?.result && (
          <div style={{ padding: '0 12px 12px' }}>
            {patternTest.result.valid
              ? <span className="muted">{patternTest.result.matches.length} match(es): <span className="mono">{patternTest.result.matches.join(', ') || 'none'}</span></span>
              : <span style={{ color: 'var(--danger)' }}>{patternTest.result.error}</span>}
          </div>
        )}
      </div>

      <div className="card">
        <div className="section-title">Clients</div>
        <table>
          <thead><tr><th>Client</th><th>Services</th><th>Domains</th><th>Contacts</th><th>Patterns</th></tr></thead>
          <tbody>
            {data.clients.map((c) => (
              <tr key={c.id}>
                <td><strong>{c.name}</strong></td>
                <td>{c.tier ?? '—'}</td>
                <td className="mono" style={{ fontSize: 11 }}>{toList(c.domains).join(', ') || '—'}</td>
                <td className="mono" style={{ fontSize: 11 }}>{toList(c.contacts).join(', ') || '—'}</td>
                <td className="mono" style={{ fontSize: 11 }}>
                  {(Array.isArray(c.patterns) ? c.patterns : []).map((p: any) => (
                    <div key={p.id}>
                      {p.pattern}
                      <button className="btn small danger" style={{ marginLeft: 6 }}
                        onClick={() => act(() => api.settingsDelete(`client-patterns/${p.id}`), 'Pattern removed.')}>×</button>
                    </div>
                  ))}
                  <button className="btn small" onClick={() => {
                    const pattern = window.prompt(`Regex for ${c.name}, matched against the full sender address`);
                    if (pattern) void act(() => api.settingsPost(`clients/${c.id}/patterns`, { pattern }), 'Pattern added.');
                  }}>+ pattern</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
