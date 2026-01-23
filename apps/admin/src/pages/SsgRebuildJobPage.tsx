import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { adminApi, SsgRebuildJobDetail, SsgRebuildJobStats, SsgRebuildResult } from '../api/client'
import { getJobStatusClass, getModeClass, getRouteTypeBadge, formatDate } from '../utils/badges'

export function SsgRebuildJobPage() {
  const { id } = useParams<{ id: string }>()
  const [job, setJob] = useState<SsgRebuildJobDetail | null>(null)
  const [stats, setStats] = useState<SsgRebuildJobStats | null>(null)
  const [results, setResults] = useState<SsgRebuildResult[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [routeTypeFilter, setRouteTypeFilter] = useState<string>('')
  const [failedFilter, setFailedFilter] = useState<boolean | undefined>(undefined)
  const [page, setPage] = useState(0)
  const limit = 50

  const fetchJob = async () => {
    if (!id) return
    try {
      const [jobData, statsData] = await Promise.all([
        adminApi.getSsgRebuildJob(id),
        adminApi.getSsgRebuildJobStats(id),
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
      const data = await adminApi.getSsgRebuildResults(id, {
        routeType: routeTypeFilter || undefined,
        failed: failedFilter,
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
  }, [id, routeTypeFilter, failedFilter, page])

  const handleStart = async () => {
    if (!id) return
    try {
      await adminApi.startSsgRebuildJob(id)
      fetchJob()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start')
    }
  }

  const handleCancel = async () => {
    if (!id) return
    try {
      await adminApi.cancelSsgRebuildJob(id)
      fetchJob()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to cancel')
    }
  }

  const getProgressPercent = () => {
    if (!job || job.totalRoutes === 0) return 0
    return Math.round(((job.renderedCount + job.failedCount) / job.totalRoutes) * 100)
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
        <Link to="/ssg-rebuild">Back to jobs</Link>
      </div>
    )
  }

  return (
    <div className="seo-crawl-job-page">
      <div className="page-header">
        <div>
          <Link to="/ssg-rebuild" className="back-link">Back to Jobs</Link>
          <h1>SSG Rebuild Job</h1>
        </div>
        <div className="header-actions">
          {job.status === 'Queued' && (
            <button onClick={handleStart} className="btn btn--primary">Start Rebuild</button>
          )}
          {job.status === 'Running' && (
            <button onClick={handleCancel} className="btn btn--danger">Cancel</button>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="job-overview">
        <div className="overview-card">
          <h3>Job Details</h3>
          <dl>
            <dt>Site</dt><dd>{job.siteCode}</dd>
            <dt>Mode</dt><dd><span className={getModeClass(job.mode)}>{job.mode}</span></dd>
            <dt>Status</dt><dd><span className={getJobStatusClass(job.status)}>{job.status}</span></dd>
            <dt>Progress</dt>
            <dd>
              <div className="progress-cell">
                <div className="progress-bar" style={{ width: '100px' }}>
                  <div
                    className="progress-bar__fill"
                    style={{ width: `${getProgressPercent()}%` }}
                  />
                </div>
                <span>{getProgressPercent()}%</span>
              </div>
            </dd>
            <dt>Concurrency</dt><dd>{job.concurrency}</dd>
            <dt>Timeout</dt><dd>{job.timeoutMs}ms</dd>
            <dt>Created</dt><dd>{formatDate(job.createdAt)}</dd>
            <dt>Started</dt><dd>{formatDate(job.startedAt)}</dd>
            <dt>Finished</dt><dd>{formatDate(job.finishedAt)}</dd>
          </dl>
          {job.error && <div className="job-error">Error: {job.error}</div>}
          {job.bookSlugs && job.bookSlugs.length > 0 && (
            <div className="slugs-list">
              <strong>Book Slugs:</strong> {job.bookSlugs.join(', ')}
            </div>
          )}
          {job.authorSlugs && job.authorSlugs.length > 0 && (
            <div className="slugs-list">
              <strong>Author Slugs:</strong> {job.authorSlugs.join(', ')}
            </div>
          )}
          {job.genreSlugs && job.genreSlugs.length > 0 && (
            <div className="slugs-list">
              <strong>Genre Slugs:</strong> {job.genreSlugs.join(', ')}
            </div>
          )}
        </div>

        {stats && (
          <div className="overview-card stats-card">
            <h3>Statistics</h3>
            <div className="stats-grid">
              <div className="stat">
                <span className="stat-value">{stats.total}</span>
                <span className="stat-label">Total Routes</span>
              </div>
              <div className="stat stat--success">
                <span className="stat-value">{stats.successful}</span>
                <span className="stat-label">Successful</span>
              </div>
              <div className="stat stat--server-error">
                <span className="stat-value">{stats.failed}</span>
                <span className="stat-label">Failed</span>
              </div>
              <div className="stat">
                <span className="stat-value">{Math.round(stats.avgRenderTimeMs)}ms</span>
                <span className="stat-label">Avg Time</span>
              </div>
              <div className="stat">
                <span className="stat-value">{stats.bookRoutes}</span>
                <span className="stat-label">Books</span>
              </div>
              <div className="stat">
                <span className="stat-value">{stats.authorRoutes}</span>
                <span className="stat-label">Authors</span>
              </div>
              <div className="stat">
                <span className="stat-value">{stats.genreRoutes}</span>
                <span className="stat-label">Genres</span>
              </div>
              <div className="stat">
                <span className="stat-value">{stats.staticRoutes}</span>
                <span className="stat-label">Static</span>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="results-section">
        <h2>Results ({total})</h2>

        <div className="filters">
          <select value={routeTypeFilter} onChange={e => { setRouteTypeFilter(e.target.value); setPage(0) }}>
            <option value="">All Types</option>
            <option value="static">Static</option>
            <option value="book">Book</option>
            <option value="author">Author</option>
            <option value="genre">Genre</option>
          </select>
          <select
            value={failedFilter === undefined ? '' : failedFilter ? 'failed' : 'success'}
            onChange={e => {
              setFailedFilter(e.target.value === '' ? undefined : e.target.value === 'failed')
              setPage(0)
            }}
          >
            <option value="">All Results</option>
            <option value="success">Successful</option>
            <option value="failed">Failed</option>
          </select>
          <button onClick={fetchResults} className="btn btn--secondary">Refresh</button>
        </div>

        {results.length === 0 ? (
          <p className="empty-state">No results match the current filters.</p>
        ) : (
          <>
            <table className="data-table results-table">
              <thead>
                <tr>
                  <th>Route</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Time</th>
                  <th>Rendered At</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <tr key={r.id}>
                    <td className="url-cell" title={r.route}>
                      {r.route.length > 50 ? r.route.slice(0, 50) + '...' : r.route}
                    </td>
                    <td>{getRouteTypeBadge(r.routeType)}</td>
                    <td>
                      <span className={r.success ? 'badge badge--success' : 'badge badge--error'}>
                        {r.success ? 'OK' : 'FAIL'}
                      </span>
                    </td>
                    <td>{r.renderTimeMs ? `${r.renderTimeMs}ms` : '-'}</td>
                    <td>{formatDate(r.renderedAt)}</td>
                    <td className="error-cell" title={r.error || undefined}>
                      {r.error ? (r.error.length > 40 ? r.error.slice(0, 40) + '...' : r.error) : '-'}
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
