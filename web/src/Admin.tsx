import { useEffect, useState } from 'react';
import { api, timeAgo } from './api';

export function Admin({ onChanged }: { onChanged: () => void }) {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => api.adminOverview().then(setData).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  async function job(name: string, label: string) {
    setBusy(name);
    setError(null);
    try {
      const res = await api.adminPost(name);
      setNotice(`${label}: ${JSON.stringify(res).slice(0, 220)}`);
      await load();
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <div className="empty">{error ?? 'Loading…'}</div>;

  return (
    <>
      <div className="header"><div><h1>Admin</h1><div className="subtitle">Org domains, mailboxes, rules and manual jobs.</div></div></div>

      {notice && <div className="banner info">{notice}</div>}
      {error && <div className="banner danger">{error}</div>}

      {!data.config.sendEnabled && (
        <div className="banner warn">
          <strong>Dry-run mode.</strong> SEND_ENABLED=false, so replies are logged on the server rather than sent.
          {!data.config.gmailWriteEnabled && ' GMAIL_WRITE_ENABLED=false, so no labels are modified either.'}
        </div>
      )}

      <div className="toolbar">
        <button className="btn" disabled={busy !== null} onClick={() => job('sync', 'Mailbox sync')}>{busy === 'sync' ? 'Syncing…' : 'Sync mailboxes'}</button>
        <button className="btn" disabled={busy !== null} onClick={() => job('sync-clients', 'Client sync')}>Sync clients</button>
        <button className="btn" disabled={busy !== null} onClick={() => job('discover', 'Discovery')}>Discover mailboxes</button>
        <button className="btn" disabled={busy !== null} onClick={() => job('reconcile', 'Reconcile')}>Reconcile open items</button>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="section-title">Configuration</div>
          <table>
            <tbody>
              <tr><td>Gmail backend</td><td><strong>{data.config.backend}</strong></td></tr>
              <tr><td>Sending</td><td><strong>{data.config.sendEnabled ? 'live' : 'dry run'}</strong></td></tr>
              <tr><td>Gmail writes</td><td><strong>{data.config.gmailWriteEnabled ? 'enabled' : 'disabled'}</strong></td></tr>
              <tr><td>Classifier</td><td><strong>{data.config.classifier}</strong></td></tr>
              <tr><td>Backfill window</td><td>{data.config.backfillDays} days</td></tr>
              <tr><td>Default SLA</td><td>{data.config.slaHours} business hours</td></tr>
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="section-title">Org domains</div>
          <table>
            <tbody>
              {data.domains.map((d: any) => (
                <tr key={d.domain}><td className="mono">{d.domain}</td><td>{d.is_group ? 'group' : ''}</td></tr>
              ))}
            </tbody>
          </table>
          <AddDomain onAdded={load} />
        </div>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">Mailboxes</div>
        <table>
          <thead><tr><th>Mailbox</th><th>Kind</th><th>Status</th><th>Last synced</th><th>Watch expires</th><th>Error</th></tr></thead>
          <tbody>
            {data.mailboxes.map((m: any) => (
              <tr key={m.email}>
                <td className="mono">{m.email}</td>
                <td>{m.kind}</td>
                <td style={{ color: m.status === 'active' ? 'var(--ok)' : 'var(--muted)' }}>{m.status}</td>
                <td className="muted">{timeAgo(m.last_synced_at)}</td>
                <td className="muted">{m.watch_expiration ? new Date(m.watch_expiration).toLocaleString() : '—'}</td>
                <td className="muted">{m.last_error ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">Block / allow rules</div>
        <table>
          <thead><tr><th>Type</th><th>Value</th><th>Added by</th><th></th></tr></thead>
          <tbody>
            {data.rules.length === 0 && <tr><td colSpan={4} className="muted">No rules yet. They are created by the "always ignore" actions.</td></tr>}
            {data.rules.map((r: any) => (
              <tr key={r.id}>
                <td>{r.type}</td>
                <td className="mono">{r.value}</td>
                <td className="muted">{r.created_by}</td>
                <td><button className="btn small danger" onClick={() => api.adminDelete(`rules/${r.id}`).then(load)}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <AddRule onAdded={load} />
      </div>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="section-title">Exclusions — never read these</div>
        <table>
          <thead><tr><th>Kind</th><th>Value</th><th>Reason</th></tr></thead>
          <tbody>
            {data.exclusions.length === 0 && <tr><td colSpan={3} className="muted">None. Add HR, legal or personal mailboxes here before going live.</td></tr>}
            {data.exclusions.map((e: any) => (
              <tr key={e.id}><td>{e.kind}</td><td className="mono">{e.value}</td><td className="muted">{e.reason ?? ''}</td></tr>
            ))}
          </tbody>
        </table>
        <AddExclusion onAdded={load} />
      </div>
    </>
  );
}

function AddDomain({ onAdded }: { onAdded: () => void }) {
  const [domain, setDomain] = useState('');
  const [isGroup, setIsGroup] = useState(false);
  return (
    <div className="toolbar" style={{ padding: 12, marginBottom: 0 }}>
      <input type="text" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} />
      <label className="muted" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" checked={isGroup} onChange={(e) => setIsGroup(e.target.checked)} /> group
      </label>
      <button className="btn" disabled={!domain} onClick={() => api.adminPost('org-domains', { domain, isGroup }).then(() => { setDomain(''); onAdded(); })}>Add</button>
    </div>
  );
}

function AddRule({ onAdded }: { onAdded: () => void }) {
  const [type, setType] = useState('block_sender');
  const [value, setValue] = useState('');
  return (
    <div className="toolbar" style={{ padding: 12, marginBottom: 0 }}>
      <select value={type} onChange={(e) => setType(e.target.value)}>
        <option value="block_sender">Block sender</option>
        <option value="block_domain">Block domain</option>
        <option value="allow_sender">Always allow sender</option>
      </select>
      <input type="text" placeholder="address or domain" value={value} onChange={(e) => setValue(e.target.value)} />
      <button className="btn" disabled={!value} onClick={() => api.adminPost('rules', { type, value }).then(() => { setValue(''); onAdded(); })}>Add rule</button>
    </div>
  );
}

function AddExclusion({ onAdded }: { onAdded: () => void }) {
  const [kind, setKind] = useState('mailbox');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  return (
    <div className="toolbar" style={{ padding: 12, marginBottom: 0 }}>
      <select value={kind} onChange={(e) => setKind(e.target.value)}>
        <option value="mailbox">Mailbox</option>
        <option value="label">Label</option>
      </select>
      <input type="text" placeholder={kind === 'mailbox' ? 'hr@cubehq.ai' : 'LEGAL'} value={value} onChange={(e) => setValue(e.target.value)} />
      <input type="text" placeholder="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      <button className="btn" disabled={!value} onClick={() => api.adminPost('exclusions', { kind, value, reason }).then(() => { setValue(''); setReason(''); onAdded(); })}>Exclude</button>
    </div>
  );
}
