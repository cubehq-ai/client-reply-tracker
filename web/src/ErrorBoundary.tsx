import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode; onReset?: () => void }
interface State { error: Error | null }

/**
 * Keeps one broken view from taking the whole app down.
 *
 * Without this, a render error anywhere unmounts the entire tree: the page
 * goes blank and even the navigation stops responding, which reads as
 * "nothing opens" rather than "this one screen is broken".
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('view crashed:', error, info.componentStack);
  }

  reset = (): void => {
    this.setState({ error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card" style={{ padding: 20, margin: '12px 0' }}>
        <h1 style={{ fontSize: 16, marginBottom: 6 }}>This view hit an error</h1>
        <p className="muted" style={{ marginTop: 0 }}>
          The rest of the app still works — pick another section, or try again.
        </p>
        <pre className="mono" style={{ whiteSpace: 'pre-wrap', color: 'var(--danger)', margin: '10px 0' }}>
          {this.state.error.message}
        </pre>
        <button className="btn" onClick={this.reset}>Try again</button>
      </div>
    );
  }
}
