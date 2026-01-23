import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { adminApi, SsgRebuildJobListItem, SsgRebuildJobStatus, SsgRebuildMode, SsgRebuildPreview, DEFAULT_SITE_ID } from '../api/client'

export function SsgRebuildPage() {
  const [jobs, setJobs] = useState<SsgRebuildJobListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [statusFilter, setStatusFilter] = useState<SsgRebuildJobStatus | ''>('')

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [createMode, setCreateMode] = useState<SsgRebuildMode>('Full')
  const [createConcurrency, setCreateConcurrency] = useState(4)
  const [preview, setPreview] = useState<SsgRebuildPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [creating, setCreating] = useState(false)

  const fetchData = async () => {
    try {
      const jobsData = await adminApi.getSsgRebuildJobs({
        siteId: DEFAULT_SITE_ID,
        status: statusFilter || undefined,
        limit: 50,
      })
      setJobs(jobsData.items)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 5000)
    return () => clearInterval(interval)
  }, [statusFilter])

  // Load preview when create form opens or mode changes
  useEffect(() => {
    if (!showCreate) {
      setPreview(null)
      return
    }

    const loadPreview = async () => {
      setPreviewLoading(true)
      try {
        const data = await adminApi.getSsgRebuildPreview(DEFAULT_SITE_ID, createMode)
        setPreview(data)
      } catch (err) {
        setPreview(null)
      } finally {
        setPreviewLoading(false)
      }
    }
    loadPreview()
  }, [showCreate, createMode])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()

    setCreating(true)
    try {
      await adminApi.createSsgRebuildJob({
        siteId: DEFAULT_SITE_ID,
        mode: createMode,
        concurrency: createConcurrency,
      })
      setShowCreate(false)
      setPreview(null)
      fetchData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create job')
    } finally {
      setCreating(false)
    }
  }

  const handleStart = async (id: string) => {
    try {
      await adminApi.startSsgRebuildJob(id)
      fetchData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start')
    }
  }

  const handleCancel = async (id: string) => {
    try {
      await adminApi.cancelSsgRebuildJob(id)
      fetchData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel')
    }
  }

  const getStatusBadge = (status: SsgRebuildJobStatus) => {
    const classes: Record<SsgRebuildJobStatus, string> = {
      Queued: 'badge badge--queued',
      Running: 'badge badge--processing',
      Completed: 'badge badge--success',
      Failed: 'badge badge--error',
      Cancelled: 'badge badge--cancelled',
    }
    return <span className={classes[status] || 'badge'}>{status}</span>
  }

  const getModeBadge = (mode: SsgRebuildMode) => {
    const classes: Record<SsgRebuildMode, string> = {
      Full: 'badge badge--info',
      Incremental: 'badge badge--warning',
      Specific: 'badge badge--secondary',
    }
    return <span className={classes[mode] || 'badge'}>{mode}</span>
  }

  const formatDate = (date: string | null) => {
    if (!date) return '-'
    return new Date(date).toLocaleString()
  }

  const getProgressPercent = (job: SsgRebuildJobListItem) => {
    if (job.totalRoutes === 0) return 0
    return Math.round(((job.renderedCount + job.failedCount) / job.totalRoutes) * 100)
  }

  if (loading) {
    return (
      <div className="seo-crawl-page">
        <h1>SSG Rebuild</h1>
        <p>Loading...</p>
      </div>
    )
  }

  return (
    <div className="seo-crawl-page">
      <div className="page-header">
        <h1>SSG Rebuild</h1>
        <button onClick={() => setShowCreate(!showCreate)} className="btn btn--primary">
          {showCreate ? 'Cancel' : 'New Rebuild'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {showCreate && (
        <form onSubmit={handleCreate} className="create-form">
          <h3>Create New SSG Rebuild Job</h3>
          <p className="form-description">
            Pre-render pages to static HTML for faster SEO indexing.
          </p>

          <div className="form-row">
            <label>
              Mode
              <select
                value={createMode}
                onChange={e => setCreateMode(e.target.value as SsgRebuildMode)}
              >
                <option value="Full">Full - All pages</option>
                <option value="Incremental">Incremental - New/changed only</option>
                <option value="Specific">Specific - Selected items</option>
              </select>
            </label>
          </div>

          <div className="form-row">
            <label>
              Concurrency
              <input
                type="number"
                value={createConcurrency}
                onChange={e => setCreateConcurrency(Number(e.target.value))}
                min={1}
                max={8}
              />
            </label>
          </div>

          {previewLoading && <p className="preview-loading">Loading route count...</p>}

          {preview && (
            <div className="preview-box">
              <strong>Will render {preview.totalRoutes} routes:</strong>
              <ul>
                <li>{preview.staticCount} static pages</li>
                <li>{preview.bookCount} books</li>
                <li>{preview.authorCount} authors</li>
                <li>{preview.genreCount} genres</li>
              </ul>
            </div>
          )}

          <div className="form-actions">
            <button type="submit" className="btn btn--primary" disabled={creating}>
              {creating ? 'Creating...' : 'Create Job'}
            </button>
          </div>
        </form>
      )}

      <div className="filters">
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as SsgRebuildJobStatus | '')}>
          <option value="">All Status</option>
          <option value="Queued">Queued</option>
          <option value="Running">Running</option>
          <option value="Completed">Completed</option>
          <option value="Failed">Failed</option>
          <option value="Cancelled">Cancelled</option>
        </select>
        <button onClick={fetchData} className="btn btn--secondary">Refresh</button>
      </div>

      {jobs.length === 0 ? (
        <p className="empty-state">No rebuild jobs yet. Create one to start.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Mode</th>
              <th>Progress</th>
              <th>Rendered</th>
              <th>Failed</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map(job => (
              <tr key={job.id}>
                <td>{getStatusBadge(job.status)}</td>
                <td>{getModeBadge(job.mode)}</td>
                <td>
                  <div className="progress-cell">
                    <div className="progress-bar">
                      <div
                        className="progress-bar__fill"
                        style={{ width: `${getProgressPercent(job)}%` }}
                      />
                    </div>
                    <span>{getProgressPercent(job)}%</span>
                  </div>
                </td>
                <td>{job.renderedCount} / {job.totalRoutes}</td>
                <td className={job.failedCount > 0 ? 'error-count' : ''}>{job.failedCount}</td>
                <td>{formatDate(job.createdAt)}</td>
                <td className="actions-cell">
                  <Link to={`/ssg-rebuild/${job.id}`} className="btn btn--small">View</Link>
                  {job.status === 'Queued' && (
                    <button onClick={() => handleStart(job.id)} className="btn btn--small btn--primary">Start</button>
                  )}
                  {job.status === 'Running' && (
                    <button onClick={() => handleCancel(job.id)} className="btn btn--small btn--danger">Cancel</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
