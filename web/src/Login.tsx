import { useState } from 'react';
import { api } from './api';

export function Login({ googleSso, onSignedIn }: { googleSso: boolean; onSignedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.login(email, password);
      onSignedIn();
    } catch (err: any) {
      setError(err.message ?? 'sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <h1>ReplyQueue</h1>
        <p className="subtitle">Client email still waiting on a reply.</p>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">Work email</label>
            <input id="email" type="email" value={email} autoComplete="username"
              onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </div>
          <div className="field">
            <label htmlFor="password">Password</label>
            <input id="password" type="password" value={password} autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)} required />
          </div>
          {error && <div className="banner danger">{error}</div>}
          <button className="btn primary" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>

        <div className="divider">or</div>

        <button
          className="btn"
          style={{ width: '100%' }}
          disabled={!googleSso}
          title={googleSso ? 'Sign in with your Workspace account' : 'Add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET to enable'}
          onClick={() => { window.location.href = '/api/auth/google'; }}
        >
          Continue with Google
        </button>
        {!googleSso && (
          <p className="muted" style={{ fontSize: 12, marginTop: 10, marginBottom: 0 }}>
            Google sign-in is wired up but not configured. Set <span className="mono">GOOGLE_OAUTH_CLIENT_ID</span> and{' '}
            <span className="mono">GOOGLE_OAUTH_CLIENT_SECRET</span> in <span className="mono">.env</span> to switch it on.
          </p>
        )}
      </div>
    </div>
  );
}
