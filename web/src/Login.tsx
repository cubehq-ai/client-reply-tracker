import { useState } from 'react';

export function Login({ googleSso }: { googleSso: boolean; onSignedIn: () => void }) {
  // The SSO callback cannot render a banner itself, so it redirects back with
  // the reason in the query string and the login page shows it.
  const [error] = useState<string | null>(() => {
    const reason = new URLSearchParams(window.location.search).get('sso_error');
    if (reason) window.history.replaceState({}, '', window.location.pathname);
    return reason;
  });

  return (
    <div className="login-wrap">
      <div className="card login-card">
        <h1>ReplyQueue</h1>
        <p className="subtitle">Client email still waiting on a reply.</p>

        {error && <div className="banner danger">{error}</div>}

        <button
          className="btn primary"
          style={{ width: '100%' }}
          disabled={!googleSso}
          title={googleSso ? 'Sign in with your Workspace account' : 'Google sign-in is not configured'}
          onClick={() => { window.location.href = '/api/auth/google'; }}
        >
          Continue with Google
        </button>

        {googleSso ? (
          <p className="muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
            Sign in with your work account.
          </p>
        ) : (
          <p className="muted" style={{ fontSize: 12, marginTop: 12, marginBottom: 0 }}>
            Google sign-in is the only way in and it is not configured. Set{' '}
            <span className="mono">GOOGLE_OAUTH_CLIENT_ID</span>,{' '}
            <span className="mono">GOOGLE_OAUTH_CLIENT_SECRET</span> and{' '}
            <span className="mono">GOOGLE_OAUTH_REDIRECT_URI</span>, then restart.
          </p>
        )}
      </div>
    </div>
  );
}
