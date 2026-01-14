import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { adminApi, GenreListItem, GenreStats } from '../api/client'

const DEFAULT_SITE_ID = '11111111-1111-1111-1111-111111111111'

type PublishedFilter = 'all' | 'published' | 'unpublished'

export function GenresPage() {
  const [genres, setGenres] = useState<GenreListItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [publishedFilter, setPublishedFilter] = useState<PublishedFilter>('all')
  const [offset, setOffset] = useState(0)
  const [refreshKey, setRefreshKey] = useState(0)
  const [stats, setStats] = useState<GenreStats | null>(null)
  const limit = 20

  useEffect(() => {
    adminApi.getGenreStats(DEFAULT_SITE_ID)
      .then(setStats)
      .catch(console.error)
  }, [refreshKey])

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    const hasPublishedBooks = publishedFilter === 'all' ? undefined : publishedFilter === 'published'

    adminApi.getGenres({
      siteId: DEFAULT_SITE_ID,
      search: searchQuery || undefined,
      hasPublishedBooks,
      offset,
      limit,
    })
      .then((data) => {
        if (cancelled) return
        setGenres(data.items)
        setTotal(data.total)
        setError(null)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to load genres')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [offset, searchQuery, publishedFilter, refreshKey])

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault()
    setOffset(0)
    setSearchQuery(search)
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Are you sure you want to delete "${name}"?`)) return
    try {
      await adminApi.deleteGenre(id)
      setRefreshKey((k) => k + 1)
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  const formatDate = (date: string) => new Date(date).toLocaleDateString()

  const totalPages = Math.ceil(total / limit)
  const currentPage = Math.floor(offset / limit) + 1

  return (
    <div className="genres-page">
      <div className="genres-page__header">
        <h1>Genres</h1>
        <span className="genres-page__count">{total} total</span>
        <Link to="/genres/new" className="btn btn--primary">
          New Genre
        </Link>
      </div>

      {stats && (
        <div className="stats-cards">
          <div className="stats-card">
            <div className="stats-card__value">{stats.total}</div>
            <div className="stats-card__label">Total Genres</div>
          </div>
          <div className="stats-card stats-card--success">
            <div className="stats-card__value">{stats.withPublishedBooks}</div>
            <div className="stats-card__label">Published</div>
          </div>
          <div className="stats-card stats-card--draft">
            <div className="stats-card__value">{stats.withoutPublishedBooks}</div>
            <div className="stats-card__label">Unpublished</div>
          </div>
          <div className="stats-card">
            <div className="stats-card__value">{stats.totalEditions}</div>
            <div className="stats-card__label">Total Editions</div>
          </div>
        </div>
      )}

      <div className="genres-page__filters">
        <form onSubmit={handleSearch} className="search-form">
          <input
            type="text"
            placeholder="Search by name or slug..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <button type="submit">Search</button>
        </form>
        <select
          value={publishedFilter}
          onChange={(e) => {
            setPublishedFilter(e.target.value as PublishedFilter)
            setOffset(0)
          }}
          className="status-filter"
        >
          <option value="all">All statuses</option>
          <option value="published">Published</option>
          <option value="unpublished">Unpublished</option>
        </select>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {loading ? (
        <p>Loading...</p>
      ) : genres.length === 0 ? (
        <p>No genres found.</p>
      ) : (
        <>
          <table className="genres-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Slug</th>
                <th>Editions</th>
                <th>Status</th>
                <th>Updated</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {genres.map((genre) => (
                <tr key={genre.id}>
                  <td>
                    <Link to={`/genres/${genre.id}`}>{genre.name}</Link>
                  </td>
                  <td className="slug-cell">{genre.slug}</td>
                  <td>{genre.editionCount}</td>
                  <td>
                    <span className={genre.hasPublishedBooks ? 'badge badge--success' : 'badge badge--draft'}>
                      {genre.hasPublishedBooks ? 'Published' : 'Unpublished'}
                    </span>
                  </td>
                  <td>{formatDate(genre.updatedAt)}</td>
                  <td className="actions-cell">
                    <Link to={`/genres/${genre.id}`} className="btn btn--small">
                      Edit
                    </Link>
                    {genre.editionCount === 0 && (
                      <button
                        onClick={() => handleDelete(genre.id, genre.name)}
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

          {totalPages > 1 && (
            <div className="pagination">
              <button
                onClick={() => setOffset(Math.max(0, offset - limit))}
                disabled={offset === 0}
                className="btn btn--small"
              >
                ← Prev
              </button>
              <span className="pagination__info">
                Page {currentPage} of {totalPages}
              </span>
              <button
                onClick={() => setOffset(offset + limit)}
                disabled={offset + limit >= total}
                className="btn btn--small"
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
