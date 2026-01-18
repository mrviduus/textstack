import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { adminApi, SeoCrawlJobListItem, SiteListItem, SeoCrawlJobStatus, SeoCrawlPreview } from '../api/client'

export function SeoCrawlPage() {
  const [jobs, setJobs] = useState<SeoCrawlJobListItem[]>([])
  const [sites, setSites] = useState<SiteListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [siteFilter, setSiteFilter] = useState<string>('')
  const [statusFilter, setStatusFilter] = useState<SeoCrawlJobStatus | ''>('')

  // Create form
  const [showCreate, setShowCreate] = useState(false)
  const [createSiteId, setCreateSiteId] = useState('')
  const [createMaxPages, setCreateMaxPages] = useState(500)
  const [preview, setPreview] = useState<SeoCrawlPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [creating, setCreating] = useState(false)

  const fetchData = async () => {
    try {
      const [jobsData, sitesData] = await Promise.all([
        adminApi.getSeoCrawlJobs({
          siteId: siteFilter || undefined,
          status: statusFilter || undefined,
          limit: 50,
        }),
        adminApi.getSites(),
      ])
      setJobs(jobsData.items)
      setSites(sitesData)
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
  }, [siteFilter, statusFilter])

  // Load preview when site is selected
  useEffect(() => {
    if (!createSiteId) {
      setPreview(null)
      return
    }

    const loadPreview = async () => {
      setPreviewLoading(true)
      try {
        const data = await adminApi.getSeoCrawlPreview(createSiteId)
        setPreview(data)
      } catch (err) {
        setPreview(null)
      } finally {
        setPreviewLoading(false)
      }
    }
    loadPreview()
  }, [createSiteId])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!createSiteId) return

    setCreating(true)
    try {
      await adminApi.createSeoCrawlJob({
        siteId: createSiteId,
        maxPages: createMaxPages,
      })
      setShowCreate(false)
      setCreateSiteId('')
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
      await adminApi.startSeoCrawlJob(id)
      fetchData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start')
    }
  }

  const handleCancel = async (id: string) => {
    try {
      await adminApi.cancelSeoCrawlJob(id)
      fetchData()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel')
    }
  }

  const getStatusBadge = (status: SeoCrawlJobStatus) => {
    const classes: Record<SeoCrawlJobStatus, string> = {
      Queued: 'badge badge--queued',
      Running: 'badge badge--processing',
      Completed: 'badge badge--success',
      Failed: 'badge badge--error',
      Cancelled: 'badge badge--cancelled',
    }
    return <span className={classes[status] || 'badge'}>{status}</span>
  }

  const formatDate = (date: string | null) => {
    if (!date) return '-'
    return new Date(date).toLocaleString()
  }

  if (loading) {
    return (
      <div className="seo-crawl-page">
        <h1>SEO Crawl</h1>
        <p>Loading...</p>
      </div>
    )
  }

  return (
    <div className="seo-crawl-page">
      <div className="page-header">
        <h1>SEO Crawl</h1>
        <button onClick={() => setShowCreate(!showCreate)} className="btn btn--primary">
          {showCreate ? 'Cancel' : 'New Crawl'}
        </button>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {showCreate && (
        <form onSubmit={handleCreate} className="create-form">
          <h3>Create New Crawl Job</h3>
          <p className="form-description">
            Crawl all URLs from the site's sitemap as Googlebot to check for SEO issues.
          </p>
          <div className="form-row">
            <label>
              Site
              <select value={createSiteId} onChange={e => setCreateSiteId(e.target.value)} required>
                <option value="">Select site...</option>
                {sites.map(s => (
                  <option key={s.id} value={s.id}>{s.code} ({s.primaryDomain})</option>
                ))}
              </select>
            </label>
            <label>
              Max Pages
              <input
                type="number"
                value={createMaxPages}
                onChange={e => setCreateMaxPages(Number(e.target.value))}
                min={1}
                max={10000}
              />
            </label>
          </div>

          {previewLoading && <p className="preview-loading">Loading URL count...</p>}

          {preview && (
            <div className="preview-box">
              <strong>Will check {preview.totalUrls} URLs:</strong>
              <ul>
                <li>{preview.bookCount} books</li>
                <li>{preview.authorCount} authors</li>
                <li>{preview.genreCount} genres</li>
              </ul>
            </div>
          )}

          <div className="form-actions">
            <button type="submit" className="btn btn--primary" disabled={creating || !createSiteId}>
              {creating ? 'Creating...' : 'Create Job'}
            </button>
          </div>
        </form>
      )}

      <div className="filters">
        <select value={siteFilter} onChange={e => setSiteFilter(e.target.value)}>
          <option value="">All Sites</option>
          {sites.map(s => (
            <option key={s.id} value={s.id}>{s.code}</option>
          ))}
        </select>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as SeoCrawlJobStatus | '')}>
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
        <p className="empty-state">No crawl jobs yet. Create one to start.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Site</th>
              <th>Status</th>
              <th>Progress</th>
              <th>Total URLs</th>
              <th>Errors</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map(job => (
              <tr key={job.id}>
                <td>{job.siteCode}</td>
                <td>{getStatusBadge(job.status)}</td>
                <td>{job.pagesCrawled} / {job.maxPages}</td>
                <td>{job.totalUrls}</td>
                <td className={job.errorsCount > 0 ? 'error-count' : ''}>{job.errorsCount}</td>
                <td>{formatDate(job.createdAt)}</td>
                <td className="actions-cell">
                  <Link to={`/seo-crawl/${job.id}`} className="btn btn--small">View</Link>
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
