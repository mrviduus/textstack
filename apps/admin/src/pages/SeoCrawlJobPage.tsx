import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { adminApi, SeoCrawlJobDetail, SeoCrawlJobStats, SeoCrawlResult } from '../api/client'

export function SeoCrawlJobPage() {
  const { id } = useParams<{ id: string }>()
  const [job, setJob] = useState<SeoCrawlJobDetail | null>(null)
  const [stats, setStats] = useState<SeoCrawlJobStats | null>(null)
  const [results, setResults] = useState<SeoCrawlResult[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [statusCodeFilter, setStatusCodeFilter] = useState<string>('')
  const [missingTitleFilter, setMissingTitleFilter] = useState(false)
  const [missingDescriptionFilter, setMissingDescriptionFilter] = useState(false)
  const [missingH1Filter, setMissingH1Filter] = useState(false)
  const [page, setPage] = useState(0)
  const limit = 50

  const fetchJob = async () => {
    if (!id) return
    try {
      const [jobData, statsData] = await Promise.all([
        adminApi.getSeoCrawlJob(id),
        adminApi.getSeoCrawlJobStats(id),
      ])
      setJob(jobData)
      setStats(statsData)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job')
    }
  }

  const fetchResults = async () => {
    if (!id) return
    try {
      // Parse status code filter into min/max for groups
      let statusCodeMin: number | undefined
      let statusCodeMax: number | undefined
      if (statusCodeFilter) {
        const group = parseInt(statusCodeFilter)
        statusCodeMin = group
        statusCodeMax = group + 100
      }

      const data = await adminApi.getSeoCrawlResults(id, {
        statusCodeMin,
        statusCodeMax,
        missingTitle: missingTitleFilter || undefined,
        missingDescription: missingDescriptionFilter || undefined,
        missingH1: missingH1Filter || undefined,
        limit,
        offset: page * limit,
      })
      setResults(data.items)
      setTotal(data.total)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load results')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchJob()
    const interval = setInterval(fetchJob, 5000)
    return () => clearInterval(interval)
  }, [id])

  useEffect(() => {
    fetchResults()
  }, [id, statusCodeFilter, missingTitleFilter, missingDescriptionFilter, missingH1Filter, page])

  const handleStart = async () => {
    if (!id) return
    try {
      await adminApi.startSeoCrawlJob(id)
      fetchJob()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start')
    }
  }

  const handleCancel = async () => {
    if (!id) return
    try {
      await adminApi.cancelSeoCrawlJob(id)
      fetchJob()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel')
    }
  }

  const getStatusClass = (status: string) => {
    const classes: Record<string, string> = {
      Queued: 'badge badge--queued',
      Running: 'badge badge--processing',
      Completed: 'badge badge--success',
      Failed: 'badge badge--error',
      Cancelled: 'badge badge--cancelled',
    }
    return classes[status] || 'badge'
  }

  const getStatusCodeClass = (code: number | null) => {
    if (!code) return ''
    if (code >= 200 && code < 300) return 'status-2xx'
    if (code >= 300 && code < 400) return 'status-3xx'
    if (code >= 400 && code < 500) return 'status-4xx'
    if (code >= 500) return 'status-5xx'
    return ''
  }

  const getUrlTypeBadge = (type: string) => {
    const classes: Record<string, string> = {
      book: 'badge badge--book',
      author: 'badge badge--author',
      genre: 'badge badge--genre',
    }
    return <span className={classes[type] || 'badge'}>{type}</span>
  }

  const formatDate = (date: string | null) => {
    if (!date) return '-'
    return new Date(date).toLocaleString()
  }

  const totalPages = Math.ceil(total / limit)

  if (loading && !job) {
    return (
      <div className="seo-crawl-job-page">
        <p>Loading...</p>
      </div>
    )
  }

  if (!job) {
    return (
      <div className="seo-crawl-job-page">
        <p>Job not found</p>
        <Link to="/seo-crawl">Back to jobs</Link>
      </div>
    )
  }

  return (
    <div className="seo-crawl-job-page">
      <div className="page-header">
        <div>
          <Link to="/seo-crawl" className="back-link">Back to Jobs</Link>
          <h1>Crawl Job</h1>
        </div>
        <div className="header-actions">
          {job.status === 'Queued' && (
            <button onClick={handleStart} className="btn btn--primary">Start Crawl</button>
          )}
          {job.status === 'Running' && (
            <button onClick={handleCancel} className="btn btn--danger">Cancel</button>
          )}
          {(job.status === 'Completed' || job.status === 'Failed') && (
            <a href={adminApi.getSeoCrawlExportUrl(job.id)} className="btn btn--secondary" download>
              Export CSV
            </a>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="job-overview">
        <div className="overview-card">
          <h3>Job Details</h3>
          <dl>
            <dt>Site</dt><dd>{job.siteCode}</dd>
            <dt>Status</dt><dd><span className={getStatusClass(job.status)}>{job.status}</span></dd>
            <dt>Progress</dt><dd>{job.pagesCrawled} / {job.totalUrls}</dd>
            <dt>Max Pages</dt><dd>{job.maxPages}</dd>
            <dt>Concurrency</dt><dd>{job.concurrency}</dd>
            <dt>Delay</dt><dd>{job.crawlDelayMs}ms</dd>
            <dt>Created</dt><dd>{formatDate(job.createdAt)}</dd>
            <dt>Started</dt><dd>{formatDate(job.startedAt)}</dd>
            <dt>Finished</dt><dd>{formatDate(job.finishedAt)}</dd>
          </dl>
          {job.error && <div className="job-error">Error: {job.error}</div>}
        </div>

        {stats && (
          <div className="overview-card stats-card">
            <h3>Statistics</h3>
            <div className="stats-grid">
              <div className="stat">
                <span className="stat-value">{stats.total}</span>
                <span className="stat-label">Total Pages</span>
              </div>
              <div className="stat stat--success">
                <span className="stat-value">{stats.status2xx}</span>
                <span className="stat-label">2xx</span>
              </div>
              <div className="stat stat--redirect">
                <span className="stat-value">{stats.status3xx}</span>
                <span className="stat-label">3xx</span>
              </div>
              <div className="stat stat--client-error">
                <span className="stat-value">{stats.status4xx}</span>
                <span className="stat-label">4xx</span>
              </div>
              <div className="stat stat--server-error">
                <span className="stat-value">{stats.status5xx}</span>
                <span className="stat-label">5xx</span>
              </div>
              <div className="stat stat--warning">
                <span className="stat-value">{stats.missingTitle}</span>
                <span className="stat-label">Missing Title</span>
              </div>
              <div className="stat stat--warning">
                <span className="stat-value">{stats.missingDescription}</span>
                <span className="stat-label">Missing Desc</span>
              </div>
              <div className="stat stat--warning">
                <span className="stat-value">{stats.missingH1}</span>
                <span className="stat-label">Missing H1</span>
              </div>
              <div className="stat stat--noindex">
                <span className="stat-value">{stats.noIndex}</span>
                <span className="stat-label">NoIndex</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="results-section">
        <h2>Results ({total})</h2>

        <div className="filters">
          <select value={statusCodeFilter} onChange={e => { setStatusCodeFilter(e.target.value); setPage(0) }}>
            <option value="">All Status Codes</option>
            <option value="200">2xx Success</option>
            <option value="300">3xx Redirect</option>
            <option value="400">4xx Client Error</option>
            <option value="500">5xx Server Error</option>
          </select>
          <label className="checkbox-filter">
            <input
              type="checkbox"
              checked={missingTitleFilter}
              onChange={e => { setMissingTitleFilter(e.target.checked); setPage(0) }}
            />
            Missing Title
          </label>
          <label className="checkbox-filter">
            <input
              type="checkbox"
              checked={missingDescriptionFilter}
              onChange={e => { setMissingDescriptionFilter(e.target.checked); setPage(0) }}
            />
            Missing Description
          </label>
          <label className="checkbox-filter">
            <input
              type="checkbox"
              checked={missingH1Filter}
              onChange={e => { setMissingH1Filter(e.target.checked); setPage(0) }}
            />
            Missing H1
          </label>
          <button onClick={fetchResults} className="btn btn--secondary">Refresh</button>
        </div>

        {results.length === 0 ? (
          <p className="empty-state">No results match the current filters.</p>
        ) : (
          <>
            <table className="data-table results-table">
              <thead>
                <tr>
                  <th>URL</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Title</th>
                  <th>Meta Desc</th>
                  <th>H1</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <tr key={r.id}>
                    <td className="url-cell" title={r.url}>
                      <a href={r.url} target="_blank" rel="noopener">
                        {r.url.length > 50 ? r.url.slice(0, 50) + '...' : r.url}
                      </a>
                    </td>
                    <td>{getUrlTypeBadge(r.urlType)}</td>
                    <td className={getStatusCodeClass(r.statusCode)}>
                      {r.statusCode || '-'}
                    </td>
                    <td className={!r.title ? 'missing' : ''} title={r.title || undefined}>
                      {r.title ? (r.title.length > 40 ? r.title.slice(0, 40) + '...' : r.title) : '-'}
                    </td>
                    <td className={!r.metaDescription ? 'missing' : ''} title={r.metaDescription || undefined}>
                      {r.metaDescription ? (r.metaDescription.length > 30 ? r.metaDescription.slice(0, 30) + '...' : r.metaDescription) : '-'}
                    </td>
                    <td className={!r.h1 ? 'missing' : ''} title={r.h1 || undefined}>
                      {r.h1 ? (r.h1.length > 30 ? r.h1.slice(0, 30) + '...' : r.h1) : '-'}
                    </td>
                    <td className="error-cell" title={r.fetchError || undefined}>
                      {r.fetchError ? (r.fetchError.length > 30 ? r.fetchError.slice(0, 30) + '...' : r.fetchError) : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {totalPages > 1 && (
              <div className="pagination">
                <button
                  onClick={() => setPage(p => Math.max(0, p - 1))}
                  disabled={page === 0}
                  className="btn btn--small"
                >
                  Previous
                </button>
                <span>Page {page + 1} of {totalPages}</span>
                <button
                  onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
                  disabled={page >= totalPages - 1}
                  className="btn btn--small"
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
