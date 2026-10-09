import { useEffect, useState } from 'react';
import { api, timeAgo } from './api';

export function Metrics() {
  const [m, setM] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { api.metrics().then(setM).catch((e) => setError(e.message)); }, []);
  if (!m) return <div className="empty">{error ?? 'Loading…'}</div>;

  const pct = (n: number | null) => (n === null ? '—' : `${Math.round(n * 100)}%`);

  return (
    <>
      <div className="header"><div><h1>Metrics</h1><div className="subtitle">Response times, SLA breaches and how well the classifier and rules are doing.</div></div></div>

      <div className="grid-2" style={{ marginBottom: 14 }}>
        <div className="card stat"><div className="n" style={{ color: m.slaBreaches > 0 ? 'var(--danger)' : undefined }}>{m.slaBreaches}</div><div className="l">SLA breaches, open now</div></div>
        <div className="card stat"><div className="n">{pct(m.reopenRate)}</div><div className="l">Reopen rate</div></div>
        <div className="card stat"><div className="n">{pct(m.classifier.precision)}</div><div className="l">FYI calls the team did not overturn</div></div>
        <div className="card stat"><div className="n">{pct(m.filterAudit.restoreRate)}</div><div className="l">Filtered mail restored by users</div></div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="section-title">First-response time</div>
        <table>
          <thead><tr><th>Client</th><th>Replied by</th><th className="num">Replies</th><th className="num">Median</th><th className="num">p90</th></tr></thead>
          <tbody>
            {m.responseTimes.length === 0 && <tr><td colSpan={5} className="muted">No replies recorded yet.</td></tr>}
            {m.responseTimes.map((r: any, i: number) => (
              <tr key={i}>
                <td>{r.client}</td><td className="mono">{r.owner}</td>
                <td className="num">{r.replies}</td>
                <td className="num">{r.median_minutes}m</td>
                <td className="num">{r.p90_minutes}m</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="section-title">Open by owner</div>
          <table>
            <thead><tr><th>Owner</th><th className="num">Open</th><th>Oldest</th></tr></thead>
            <tbody>
              {m.openByOwner.map((r: any, i: number) => (
                <tr key={i}><td className="mono">{r.owner}</td><td className="num">{r.open_count}</td><td className="muted">{timeAgo(r.oldest_open)}</td></tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="card">
          <div className="section-title">Open by client</div>
          <table>
            <thead><tr><th>Client</th><th className="num">Open</th><th className="num">Overdue</th><th>Oldest</th></tr></thead>
            <tbody>
              {m.openByClient.map((r: any, i: number) => (
                <tr key={i}>
                  <td>{r.client}</td><td className="num">{r.open_count}</td>
                  <td className="num" style={{ color: r.overdue_count > 0 ? 'var(--danger)' : undefined }}>{r.overdue_count}</td>
                  <td className="muted">{timeAgo(r.oldest_open)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
