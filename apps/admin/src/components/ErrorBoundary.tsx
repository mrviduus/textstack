import { Component, ErrorInfo, ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
  info: ErrorInfo | null
}

/**
 * Catches render-time throws anywhere under it and shows a recoverable error
 * page instead of a blank white screen. Added after `EditAuthor` rendered a
 * raw `{theme, description}` object as a React child and React tore down the
 * entire app — the page looked frozen ("админка виснет") when in fact the
 * subtree had unmounted.
 *
 * Class component because React requires `componentDidCatch` /
 * `getDerivedStateFromError`, which only exist on class boundaries. Pages
 * that fix their data should still load on next nav — we don't persist the
 * error state across route changes; the boundary re-mounts via `key={pathname}`
 * upstream if needed (today: per-route remount via Routes is sufficient).
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[admin] uncaught render error:', error, info.componentStack)
    this.setState({ info })
  }

  reset = () => this.setState({ error: null, info: null })

  render() {
    const { error, info } = this.state
    if (!error) return this.props.children

    return (
      <div style={{
        padding: '32px',
        maxWidth: '720px',
        margin: '64px auto',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      }}>
        <h1 style={{ fontSize: '24px', marginBottom: '8px', color: '#dc2626' }}>
          Something broke in this page
        </h1>
        <p style={{ color: '#666', marginBottom: '24px' }}>
          The admin panel hit an unexpected render error. Reload the page;
          the error is logged to the browser
          console so you can copy details if it's reproducible.
        </p>
        <details style={{
          background: '#fef2f2',
          border: '1px solid #fecaca',
          borderRadius: '6px',
          padding: '12px',
          marginBottom: '16px',
          fontFamily: 'ui-monospace, monospace',
          fontSize: '13px',
          color: '#7f1d1d',
        }}>
          <summary style={{ cursor: 'pointer', marginBottom: '8px' }}>{error.message || 'Error'}</summary>
          <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{error.stack}</pre>
          {info?.componentStack && (
            <pre style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', color: '#9f1239' }}>
              {info.componentStack}
            </pre>
          )}
        </details>
        <button
          onClick={this.reset}
          style={{
            padding: '8px 16px',
            background: '#2563eb',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            marginRight: '8px',
          }}
        >
          Try again
        </button>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '8px 16px',
            background: '#e5e7eb',
            color: '#111',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
          }}
        >
          Reload page
        </button>
      </div>
    )
  }
}
