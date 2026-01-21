import { useState } from 'react'
import { adminApi, DEFAULT_SITE_ID, ReprocessResult, ReimportResult, SyncResult, RestoreResult } from '../api/client'

type OperationStatus = 'idle' | 'running' | 'success' | 'error'

interface OperationState {
  status: OperationStatus
  result?: ReprocessResult | ReimportResult | SyncResult | RestoreResult
  error?: string
}

export function ToolsPage() {
  const [reprocess, setReprocess] = useState<OperationState>({ status: 'idle' })
  const [reimport, setReimport] = useState<OperationState>({ status: 'idle' })
  const [sync, setSync] = useState<OperationState>({ status: 'idle' })
  const [restore, setRestore] = useState<OperationState>({ status: 'idle' })
  const [syncLimit, setSyncLimit] = useState<string>('')

  const handleReprocessAll = async () => {
    if (!confirm('Reprocess all published editions? This may take a while.')) return
    setReprocess({ status: 'running' })
    try {
      const result = await adminApi.reprocessAllEditions(DEFAULT_SITE_ID)
      setReprocess({ status: 'success', result })
    } catch (err) {
      setReprocess({ status: 'error', error: err instanceof Error ? err.message : 'Failed' })
    }
  }

  const handleReimport = async () => {
    if (!confirm('Reimport all TextStack books? This will update chapters but keep SEO metadata.')) return
    setReimport({ status: 'running' })
    try {
      const result = await adminApi.reimportTextStack(DEFAULT_SITE_ID)
      setReimport({ status: 'success', result })
    } catch (err) {
      setReimport({ status: 'error', error: err instanceof Error ? err.message : 'Failed' })
    }
  }

  const handleSync = async () => {
    const limit = syncLimit ? parseInt(syncLimit, 10) : undefined
    if (!confirm(`Sync from Standard Ebooks${limit ? ` (limit: ${limit})` : ''}?`)) return
    setSync({ status: 'running' })
    try {
      const result = await adminApi.syncStandardEbooks(DEFAULT_SITE_ID, limit)
      setSync({ status: 'success', result })
    } catch (err) {
      setSync({ status: 'error', error: err instanceof Error ? err.message : 'Failed' })
    }
  }

  const handleRestore = async () => {
    const limit = syncLimit ? parseInt(syncLimit, 10) : undefined
    if (!confirm(`Restore missing Standard Ebooks sources${limit ? ` (limit: ${limit})` : ''}?`)) return
    setRestore({ status: 'running' })
    try {
      const result = await adminApi.restoreStandardEbooksSources(DEFAULT_SITE_ID, limit)
      setRestore({ status: 'success', result })
    } catch (err) {
      setRestore({ status: 'error', error: err instanceof Error ? err.message : 'Failed' })
    }
  }

  const renderStatus = (state: OperationState) => {
    if (state.status === 'running') return <span className="badge badge--warning">Running...</span>
    if (state.status === 'success') return <span className="badge badge--success">Done</span>
    if (state.status === 'error') return <span className="badge badge--danger">{state.error}</span>
    return null
  }

  const renderResult = (state: OperationState) => {
    if (state.status !== 'success' || !state.result) return null
    return (
      <pre className="tools-result">
        {JSON.stringify(state.result, null, 2)}
      </pre>
    )
  }

  return (
    <div className="tools-page">
      <h1>Tools</h1>
      <p className="tools-page__subtitle">Maintenance and sync operations</p>

      <div className="tools-grid">
        <div className="tool-card">
          <h3>Reprocess All Editions</h3>
          <p>Re-parse all published editions. Use after changing chapter splitting logic.</p>
          <div className="tool-card__actions">
            <button
              onClick={handleReprocessAll}
              disabled={reprocess.status === 'running'}
              className="btn btn--primary"
            >
              {reprocess.status === 'running' ? 'Processing...' : 'Reprocess All'}
            </button>
            {renderStatus(reprocess)}
          </div>
          {renderResult(reprocess)}
        </div>

        <div className="tool-card">
          <h3>Reimport TextStack</h3>
          <p>Reimport books from TextStack folder. Updates chapters but keeps SEO metadata.</p>
          <div className="tool-card__actions">
            <button
              onClick={handleReimport}
              disabled={reimport.status === 'running'}
              className="btn btn--primary"
            >
              {reimport.status === 'running' ? 'Importing...' : 'Reimport'}
            </button>
            {renderStatus(reimport)}
          </div>
          {renderResult(reimport)}
        </div>

        <div className="tool-card">
          <h3>Sync Standard Ebooks</h3>
          <p>Import new books from Standard Ebooks GitHub repository.</p>
          <div className="tool-card__input">
            <label>
              Limit (optional):
              <input
                type="number"
                value={syncLimit}
                onChange={(e) => setSyncLimit(e.target.value)}
                placeholder="No limit"
                min="1"
              />
            </label>
          </div>
          <div className="tool-card__actions">
            <button
              onClick={handleSync}
              disabled={sync.status === 'running'}
              className="btn btn--primary"
            >
              {sync.status === 'running' ? 'Syncing...' : 'Sync'}
            </button>
            {renderStatus(sync)}
          </div>
          {renderResult(sync)}
        </div>

        <div className="tool-card">
          <h3>Restore Standard Ebooks Sources</h3>
          <p>Download missing source files for already imported Standard Ebooks.</p>
          <div className="tool-card__actions">
            <button
              onClick={handleRestore}
              disabled={restore.status === 'running'}
              className="btn btn--primary"
            >
              {restore.status === 'running' ? 'Restoring...' : 'Restore Sources'}
            </button>
            {renderStatus(restore)}
          </div>
          {renderResult(restore)}
        </div>
      </div>
    </div>
  )
}
