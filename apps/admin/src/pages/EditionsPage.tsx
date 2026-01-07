import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { adminApi, Edition, AdminStats } from '../api/client'

const PAGE_SIZE = 20

export function EditionsPage() {
  const [editions, setEditions] = useState<Edition[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<string>('')
  const [languageFilter, setLanguageFilter] = useState<string>('')
  const [indexableFilter, setIndexableFilter] = useState<string>('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [stats, setStats] = useState<AdminStats | null>(null)

  const totalPages = Math.ceil(total / PAGE_SIZE)

  const fetchStats = async () => {
    try {
      const data = await adminApi.getStats()
      setStats(data)
    } catch (err) {
      console.error('Failed to load stats:', err)
    }
  }

  const fetchEditions = async () => {
    setLoading(true)
    try {
      const data = await adminApi.getEditions({
        status: statusFilter || undefined,
        search: search || undefined,
        language: languageFilter || undefined,
        indexable: indexableFilter === '' ? undefined : indexableFilter === 'true',
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      })
      setEditions(data.items)
      setTotal(data.total)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load editions')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStats()
  }, [])

  useEffect(() => {
    fetchEditions()
  }, [statusFilter, languageFilter, indexableFilter, page])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setPage(1)
    fetchEditions()
  }

  const handleStatusChange = (newStatus: string) => {
    setStatusFilter(newStatus)
    setPage(1)
  }

  const handleLanguageChange = (newLanguage: string) => {
    setLanguageFilter(newLanguage)
    setPage(1)
  }

  const handleIndexableChange = (value: string) => {
    setIndexableFilter(value)
    setPage(1)
  }

  const handlePublish = async (id: string) => {
    try {
      await adminApi.publishEdition(id)
      fetchEditions()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to publish')
    }
  }

  const handleUnpublish = async (id: string) => {
    try {
      await adminApi.unpublishEdition(id)
      fetchEditions()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to unpublish')
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this edition?')) return
    try {
      await adminApi.deleteEdition(id)
      fetchEditions()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  const getStatusBadge = (status: string) => {
    const classes: Record<string, string> = {
      Draft: 'badge badge--draft',
      Published: 'badge badge--success',
      Deleted: 'badge badge--error',
    }
    return <span className={classes[status] || 'badge'}>{status}</span>
  }

  const formatDate = (date: string | null) => {
    if (!date) return '-'
    return new Date(date).toLocaleDateString()
  }

  return (
    <div className="editions-page">
      <div className="editions-page__header">
        <h1>Editions</h1>
        <span className="editions-page__count">{total} total</span>
      </div>

      {stats && (
        <div className="stats-cards">
          <div className="stats-card">
            <div className="stats-card__value">{stats.totalEditions}</div>
            <div className="stats-card__label">Total Editions</div>
          </div>
          <div className="stats-card stats-card--success">
            <div className="stats-card__value">{stats.publishedEditions}</div>
            <div className="stats-card__label">Published</div>
          </div>
          <div className="stats-card stats-card--draft">
            <div className="stats-card__value">{stats.draftEditions}</div>
            <div className="stats-card__label">Drafts</div>
          </div>
          <div className="stats-card">
            <div className="stats-card__value">{stats.totalChapters}</div>
            <div className="stats-card__label">Total Chapters</div>
          </div>
          <div className="stats-card">
            <div className="stats-card__value">{stats.totalAuthors}</div>
            <div className="stats-card__label">Authors</div>
          </div>
        </div>
      )}

      <div className="editions-page__filters">
        <form onSubmit={handleSearch} className="search-form">
          <input
            type="text"
            placeholder="Search by title or author..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="submit">Search</button>
        </form>

        <select
          value={statusFilter}
          onChange={(e) => handleStatusChange(e.target.value)}
          className="status-filter"
        >
          <option value="">All statuses</option>
          <option value="Draft">Draft</option>
          <option value="Published">Published</option>
        </select>

        <select
          value={languageFilter}
          onChange={(e) => handleLanguageChange(e.target.value)}
          className="status-filter"
        >
          <option value="">All languages</option>
          <option value="en">English</option>
          <option value="uk">Ukrainian</option>
          <option value="de">German</option>
          <option value="fr">French</option>
          <option value="es">Spanish</option>
        </select>

        <select
          value={indexableFilter}
          onChange={(e) => handleIndexableChange(e.target.value)}
          className="status-filter"
        >
          <option value="">All SEO</option>
          <option value="true">Indexed</option>
          <option value="false">Not indexed</option>
        </select>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <p>Loading...</p>
      ) : editions.length === 0 ? (
        <p>No editions found.</p>
      ) : (
        <table className="editions-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Authors</th>
              <th>Lang</th>
              <th>Status</th>
              <th>Chapters</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {editions.map((edition) => (
              <tr key={edition.id}>
                <td>
                  <Link to={`/editions/${edition.id}`}>{edition.title}</Link>
                </td>
                <td>{edition.authors || '-'}</td>
                <td>{edition.language}</td>
                <td>{getStatusBadge(edition.status)}</td>
                <td>{edition.chapterCount}</td>
                <td>{formatDate(edition.createdAt)}</td>
                <td className="actions-cell">
                  <Link to={`/editions/${edition.id}`} className="btn btn--small">
                    Edit
                  </Link>
                  {edition.status === 'Draft' && (
                    <button
                      onClick={() => handlePublish(edition.id)}
                      className="btn btn--small btn--success"
                    >
                      Publish
                    </button>
                  )}
                  {edition.status === 'Published' && (
                    <button
                      onClick={() => handleUnpublish(edition.id)}
                      className="btn btn--small btn--warning"
                    >
                      Unpublish
                    </button>
                  )}
                  {edition.status !== 'Published' && (
                    <button
                      onClick={() => handleDelete(edition.id)}
                      className="btn btn--small btn--danger"
                    >
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {totalPages > 1 && (
        <div className="pagination">
          <button
            onClick={() => setPage(p => Math.max(1, p - 1))}
            disabled={page === 1}
            className="btn btn--small"
          >
            ← Prev
          </button>
          <span className="pagination__info">
            Page {page} of {totalPages}
          </span>
          <button
            onClick={() => setPage(p => Math.min(totalPages, p + 1))}
            disabled={page === totalPages}
            className="btn btn--small"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  )
}
