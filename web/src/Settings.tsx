import { useEffect, useState } from 'react';
import { api, timeAgo } from './api';

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
  { key: 'rules', label: 'Rules & exclusions' },
];

export function Settings({ onChanged }: { onChanged: () => void }) {
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
      {tab === 'rules' && <Rules />}
    </>
  );
}

function Mailboxes({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<{ mailboxes: any[]; teams: any[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [bulk, setBulk] = useState('');
  const [bulkTeam, setBulkTeam] = useState('');
  const [newTeam, setNewTeam] = useState('');

  const load = () => api.settingsMailboxes().then(setData).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  async function act(fn: () => Promise<any>, msg: string) {
    setError(null);
    try { await fn(); setNotice(msg); await load(); onChanged(); }
    catch (e: any) { setError(e.message); }
  }

  if (!data) return <div className="empty">{error ?? 'Loading…'}</div>;

  const byTeam = new Map<string, any[]>();
  for (const m of data.mailboxes) {
    const key = m.team_name ?? 'No team';
    byTeam.set(key, [...(byTeam.get(key) ?? []), m]);
  }

  return (
    <>
      {notice && <div className="banner info">{notice}</div>}
      {error && <div className="banner danger">{error}</div>}

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="section-title">Add mailboxes</div>
        <div style={{ padding: 12 }}>
          <textarea
            value={bulk}
            onChange={(e) => setBulk(e.target.value)}
            placeholder={'One address per line, or comma separated\nanna@cubehq.ai\nmary@cubehq.ai'}
            style={{ width: '100%', minHeight: 80 }}
          />
          <div className="toolbar" style={{ marginTop: 8, marginBottom: 0 }}>
            <input type="text" list="team-list" placeholder="Team (optional)" value={bulkTeam} onChange={(e) => setBulkTeam(e.target.value)} />
            <datalist id="team-list">{data.teams.map((t) => <option key={t.id} value={t.name} />)}</datalist>
            <button
              className="btn primary"
              disabled={!bulk.trim()}
              onClick={() => act(async () => {
                const emails = bulk.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
                const res = await api.settingsPost('mailboxes', { emails, team: bulkTeam || null });
                setBulk('');
                if (res.rejected?.length) setError(`Rejected: ${res.rejected.map((r: any) => `${r.email} (${r.reason})`).join(', ')}`);
              }, 'Mailboxes added.')}
            >
              Add to watch list
            </button>
            <button className="btn" onClick={() => act(() => api.settingsPost('roster'), 'Default roster applied.')}>
              Re-apply default roster
            </button>
          </div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="section-title">Teams</div>
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
        <div className="toolbar" style={{ padding: 12, marginBottom: 0 }}>
          <input type="text" placeholder="New team name" value={newTeam} onChange={(e) => setNewTeam(e.target.value)} />
          <button className="btn" disabled={!newTeam.trim()} onClick={() => act(async () => {
            await api.settingsPost('teams', { name: newTeam });
            setNewTeam('');
          }, 'Team created.')}>Add team</button>
        </div>
      </div>

      {[...byTeam.entries()].map(([team, boxes]) => (
        <div className="card" style={{ marginBottom: 14 }} key={team}>
          <div className="section-title">{team} <span className="muted">· {boxes.length}</span></div>
          <table>
            <thead><tr><th>Mailbox</th><th>Kind</th><th>Status</th><th className="num">Messages</th><th>Last synced</th><th></th></tr></thead>
            <tbody>
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
    </>
  );
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
        <div className="section-title">Unmatched senders <span className="muted">· link these to a client</span></div>
        <table>
          <thead><tr><th>Sender</th><th>Domain</th><th className="num">Items</th><th>Last seen</th><th>Link to</th></tr></thead>
          <tbody>
            {data.unmatched.length === 0 && <tr><td colSpan={5} className="muted">Nothing unmatched. </td></tr>}
            {data.unmatched.map((u) => (
              <tr key={u.from_email}>
                <td className="mono">{u.from_email}</td>
                <td className="mono muted">{u.from_domain}</td>
                <td className="num">{u.items}</td>
                <td className="muted">{timeAgo(u.last_seen)}</td>
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
          <thead><tr><th>Client</th><th>Tier</th><th>Domains</th><th>Contacts</th><th>Patterns</th></tr></thead>
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

function Rules() {
  const [data, setData] = useState<any>(null);
  const load = () => api.adminOverview().then(setData).catch(() => {});
  useEffect(() => { void load(); }, []);
  if (!data) return <div className="empty">Loading…</div>;
  return (
    <>
      <div className="card" style={{ marginBottom: 14 }}>
        <div className="section-title">Block / allow rules</div>
        <table>
          <thead><tr><th>Type</th><th>Value</th><th>Added by</th><th></th></tr></thead>
          <tbody>
            {data.rules.length === 0 && <tr><td colSpan={4} className="muted">None. Created by the "always ignore" actions.</td></tr>}
            {data.rules.map((r: any) => (
              <tr key={r.id}>
                <td>{r.type}</td><td className="mono">{r.value}</td><td className="muted">{r.created_by}</td>
                <td><button className="btn small danger" onClick={() => api.adminDelete(`rules/${r.id}`).then(load)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="card">
        <div className="section-title">Exclusions — never read these</div>
        <table>
          <thead><tr><th>Kind</th><th>Value</th><th>Reason</th></tr></thead>
          <tbody>
            {data.exclusions.length === 0 && <tr><td colSpan={3} className="muted">None. Add HR, legal and personal mailboxes here before going live.</td></tr>}
            {data.exclusions.map((e: any) => (
              <tr key={e.id}><td>{e.kind}</td><td className="mono">{e.value}</td><td className="muted">{e.reason ?? ''}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
