import './api/client' // initApi (cookie mode) before anything can call the shared api clients
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { clearExpiredCaches } from './lib/offlineDb'
import { initSentry } from './lib/sentry'

initSentry()   // no VITE_SENTRY_DSN: a no-op; else @sentry/react loads in its own chunk

// The V2 reader on the dev server only (R5, #1037), outside the app and its providers. A production
// build inlines DEV as false and drops this branch with its import: the bundle is the same as without it.
if (import.meta.env.DEV && /^\/dev\/reader-v2\/?$/.test(location.pathname)) {
  const root = document.getElementById('root')!
  import('./pages/dev/V2ReaderDevPage')
    .then(({ default: V2ReaderDevPage }) => ReactDOM.createRoot(root).render(<ErrorBoundary><V2ReaderDevPage /></ErrorBoundary>))
    .catch((e) => { root.textContent = `V2 reader dev route failed to load: ${e}` })
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  )
}

// Evict expired offline caches once, off the first-paint path. Never allowed to break the app.
setTimeout(() => {
  try { clearExpiredCaches().catch(() => {}) } catch { /* no IndexedDB */ }
}, 5000)
