import { useEffect, useMemo, useState } from 'react';
import { api, timeAgo } from './api';

const FIELDS = [
  { value: 'from_domain', label: "Sender's domain" },
  { value: 'from_email', label: "Sender's address" },
  { value: 'subject', label: 'Subject' },
  { value: 'body', label: 'Body' },
  { value: 'to_email', label: 'To address' },
  { value: 'any_recipient', label: 'Any recipient' },
  { value: 'header', label: 'Raw header' },
];

const OPS = [
  { value: 'regex', label: 'matches regex' },
  { value: 'contains', label: 'contains' },
  { value: 'equals', label: 'is exactly' },
  { value: 'ends_with', label: 'ends with' },
];

const ACTIONS = [
  { value: 'ignore', label: 'Filter out (never show)' },
  { value: 'assign_client', label: 'Assign to client' },
  { value: 'allow', label: 'Always keep (beat the filters)' },
  { value: 'set_priority', label: 'Set priority' },
];

const EXAMPLES = [
  { label: 'All Figma notifications', field: 'from_domain', op: 'regex', pattern: '(^|\\.)figma\\.com$', action: 'ignore' },
  { label: 'Any no-reply sender', field: 'from_email', op: 'regex', pattern: '^(no-?reply|donotreply)@', action: 'ignore' },
  { label: 'Job applications', field: 'subject', op: 'regex', pattern: '\\b(application|applying|resume|cv)\\b.*\\b(role|position|intern)\\b', action: 'ignore' },
  { label: 'Anything urgent', field: 'subject', op: 'regex', pattern: '\\b(urgent|asap|outage|down)\\b', action: 'set_priority' },
];

const BLANK = {
  name: '', field: 'from_domain', op: 'regex', pattern: '',
  action: 'ignore', clientId: '', priorityValue: 'high', headerName: '', priority: 100,
};

export function Rules({ clients, onChanged }: { clients: any[]; onChanged: () => void }) {
  const [rules, setRules] = useState<any[] | null>(null);
  const [draft, setDraft] = useState<any>(BLANK);
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = () => api.rules().then((r) => setRules(r.rules)).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  const payload = useMemo(() => ({
    name: draft.name || 'preview',
    field: draft.field,
    headerName: draft.field === 'header' ? draft.headerName : null,
    op: draft.op,
    pattern: draft.pattern,
    action: draft.action,
    clientId: draft.action === 'assign_client' && draft.clientId ? Number(draft.clientId) : null,
    priorityValue: draft.action === 'set_priority' ? draft.priorityValue : null,
    priority: Number(draft.priority) || 100,
  }), [draft]);

  // Preview as the pattern is typed, so a rule is never saved blind.
  useEffect(() => {
    if (!draft.pattern.trim()) { setPreview(null); return; }
    let live = true;
    const t = setTimeout(() => {
      api.rulePreview(payload).then((p) => live && setPreview(p)).catch(() => {});
    }, 400);
    return () => { live = false; clearTimeout(t); };
  }, [payload, draft.pattern]);

  async function act(fn: () => Promise<any>, msg: string) {
    setBusy(true);
    setError(null);
    try { await fn(); setNotice(msg); await load(); onChanged(); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  if (!rules) return <div className="empty">{error ?? 'Loading…'}</div>;

  return (
    <>
      {notice && <div className="banner info">{notice}</div>}
      {error && <div className="banner danger">{error}</div>}
      <div className="banner info">
        Rules run before the built-in filters and before client matching. They are the way to teach the
        system about mail it keeps getting wrong, instead of fixing items one at a time.
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <div className="section-title">
          <span>New rule</span>
          <span className="section-actions">
            {EXAMPLES.map((e) => (
              <button key={e.label} className="btn small" onClick={() => setDraft({ ...BLANK, ...e, name: e.label })}>
                {e.label}
              </button>
            ))}
          </span>
        </div>

        <div className="rule-form">
          <label className="field-row">
            <span className="field-label">Name</span>
            <input type="text" value={draft.name} placeholder="What this rule is for"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>

          <label className="field-row">
            <span className="field-label">When</span>
            <select value={draft.field} onChange={(e) => setDraft({ ...draft, field: e.target.value })}>
              {FIELDS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
            {draft.field === 'header' && (
              <input type="text" placeholder="header name, e.g. List-Id" style={{ maxWidth: 170 }}
                value={draft.headerName} onChange={(e) => setDraft({ ...draft, headerName: e.target.value })} />
            )}
            <select value={draft.op} style={{ maxWidth: 170 }} onChange={(e) => setDraft({ ...draft, op: e.target.value })}>
              {OPS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
            <input className="mono" type="text" value={draft.pattern} placeholder="pattern"
              onChange={(e) => setDraft({ ...draft, pattern: e.target.value })} />
          </label>

          <label className="field-row">
            <span className="field-label">Then</span>
            <select value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
              {ACTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
            {draft.action === 'assign_client' && (
              <select value={draft.clientId} onChange={(e) => setDraft({ ...draft, clientId: e.target.value })}>
                <option value="">Choose client…</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
            {draft.action === 'set_priority' && (
              <select value={draft.priorityValue} onChange={(e) => setDraft({ ...draft, priorityValue: e.target.value })}>
                <option value="high">High</option>
                <option value="normal">Normal</option>
                <option value="low">Low</option>
              </select>
            )}
          </label>
        </div>

        {preview && (
          <div className="rule-preview">
            {!preview.valid ? (
              <span style={{ color: 'var(--danger)' }}>{preview.error}</span>
            ) : (
              <>
                <strong>{preview.matched}</strong> of the last {preview.scanned} received messages would match
                {preview.matched > 0 && (
                  <table style={{ marginTop: 8 }}>
                    <thead><tr><th>From</th><th>Subject</th><th>Client</th><th>State</th></tr></thead>
                    <tbody>
                      {preview.samples.map((s: any, i: number) => (
                        <tr key={i}>
                          <td className="mono" style={{ fontSize: 11.5 }}>{s.from}</td>
                          <td style={{ fontSize: 12 }}>{s.subject}</td>
                          <td>{s.client ?? <span className="muted">unmatched</span>}</td>
                          <td className="muted">{s.currentState}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {preview.matched > 0 && draft.action === 'ignore' && preview.samples.some((s: any) => s.client) && (
                  <div className="banner warn" style={{ marginTop: 10 }}>
                    This would hide mail from a matched client. Check the list above before saving.
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="composer-actions">
          <button className="btn primary" disabled={busy || !draft.name.trim() || !draft.pattern.trim()}
            onClick={() => act(async () => { await api.createRule(payload); setDraft(BLANK); setPreview(null); }, 'Rule created.')}>
            Save rule
          </button>
          <button className="btn" disabled={busy} onClick={() => { setDraft(BLANK); setPreview(null); }}>Reset</button>
        </div>
      </div>

      <div className="card">
        <div className="section-title">
          <span>Rules <span className="muted">· run in order, lowest number first</span></span>
          <button className="btn small" disabled={busy || rules.length === 0}
            onClick={() => act(async () => {
              const r = await api.reapplyRules();
              setNotice(`Re-applied to ${r.conversations} conversation(s), ${r.changed} message(s) changed.`);
            }, 'Rules re-applied.')}>
            Apply to existing mail
          </button>
        </div>
        <table>
          <thead>
            <tr><th>Rule</th><th>Condition</th><th>Action</th><th className="num">Order</th><th className="num">Matches</th><th>Last</th><th></th></tr>
          </thead>
          <tbody>
            {rules.length === 0 && <tr><td colSpan={7} className="muted">No rules yet.</td></tr>}
            {rules.map((r) => (
              <tr key={r.id} style={{ opacity: r.enabled ? 1 : 0.5 }}>
                <td><strong>{r.name}</strong></td>
                <td className="mono" style={{ fontSize: 11.5 }}>
                  {FIELDS.find((f) => f.value === r.field)?.label ?? r.field} {r.op} {r.pattern}
                </td>
                <td>
                  {r.action === 'assign_client' ? `assign ${r.client_name ?? '?'}`
                    : r.action === 'set_priority' ? `priority ${r.priority_value}`
                    : r.action}
                </td>
                <td className="num">{r.priority}</td>
                <td className="num">{r.match_count}</td>
                <td className="muted">{r.last_matched_at ? timeAgo(r.last_matched_at) : '—'}</td>
                <td>
                  <button className="btn small" onClick={() => act(() => api.updateRule(r.id, { enabled: !r.enabled }), r.enabled ? 'Disabled.' : 'Enabled.')}>
                    {r.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button className="btn small danger" onClick={() => {
                    if (window.confirm(`Delete rule "${r.name}"?`)) void act(() => api.deleteRule(r.id), 'Rule deleted.');
                  }}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
