import './api/client' // initApi (cookie mode) before anything can call the shared api clients
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import { clearExpiredCaches } from './lib/offlineDb'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)

// Evict expired offline caches once, off the first-paint path. Never allowed to break the app.
setTimeout(() => {
  try { clearExpiredCaches().catch(() => {}) } catch { /* no IndexedDB */ }
}, 5000)
