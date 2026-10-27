import { useState, useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { adminApi, SsgRebuildJobDetail } from '../api/client'
import { getJobStatusClass, getModeClass, formatDate } from '../utils/badges'

export function SsgRebuildJobPage() {
  const { id } = useParams<{ id: string }>()
  const [job, setJob] = useState<SsgRebuildJobDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchJob = async () => {
    if (!id) return
    try {
      setJob(await adminApi.getSsgRebuildJob(id))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load job')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchJob()
    const interval = setInterval(fetchJob, 5000)
    return () => clearInterval(interval)
  }, [id])

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

  if (loading && !job) {
    return (
      <div className="admin-job-page">
        <p>Loading...</p>
      </div>
    )
  }

  if (!job) {
    return (
      <div className="admin-job-page">
        <p>Job not found</p>
        <Link to="/ssg-rebuild">Back to jobs</Link>
      </div>
    )
  }

  return (
    <div className="admin-job-page">
      <div className="page-header">
        <div>
          <Link to="/ssg-rebuild" className="back-link">Back to Jobs</Link>
          <h1>SSG Rebuild Job</h1>
        </div>
        <div className="header-actions">
          {(job.status === 'Queued' || job.status === 'Running') && (
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
        </div>
      </div>
    </div>
  )
}
