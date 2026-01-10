import { useState, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { useLibrary } from '../hooks/useLibrary'
import { LocalizedLink } from '../components/LocalizedLink'
import { SeoHead } from '../components/SeoHead'
import { getStorageUrl } from '../api/client'
import { stringToColor } from '../utils/colors'
import { getAllProgress, ReadingProgressDto } from '../api/auth'

export function LibraryPage() {
  const { isAuthenticated, user } = useAuth()
  const { items, loading, remove } = useLibrary()
  const [progressMap, setProgressMap] = useState<Record<string, ReadingProgressDto>>({})

  // Fetch all reading progress
  useEffect(() => {
    if (!isAuthenticated) return
    getAllProgress()
      .then((res) => {
        const map: Record<string, ReadingProgressDto> = {}
        res.items.forEach((p) => {
          map[p.editionId] = p
        })
        setProgressMap(map)
      })
      .catch(() => {})
  }, [isAuthenticated])

  if (!isAuthenticated) {
    return (
      <div className="library-page">
        <SeoHead title="My Library" />
        <div className="library-page__empty">
          <h1>My Library</h1>
          <p>Sign in to save books to your library and track your reading progress.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="library-page">
      <SeoHead title="My Library" />
      <div className="library-page__header">
        <h1>My Library</h1>
        {user && <p className="library-page__user">{user.email}</p>}
      </div>

      {loading ? (
        <div className="library-page__loading">Loading...</div>
      ) : items.length === 0 ? (
        <div className="library-page__empty">
          <p>Your library is empty.</p>
          <LocalizedLink to="/books" className="library-page__browse-btn">
            Browse Books
          </LocalizedLink>
        </div>
      ) : (
        <div className="library-page__grid">
          {items.map((item) => {
            const progress = progressMap[item.editionId]
            const percent = progress?.percent ?? 0
            return (
              <div key={item.editionId} className="library-card">
                <LocalizedLink to={`/books/${item.slug}`} className="library-card__cover">
                  {item.coverPath ? (
                    <img src={getStorageUrl(item.coverPath)} alt={item.title} />
                  ) : (
                    <div
                      className="library-card__cover-placeholder"
                      style={{ backgroundColor: stringToColor(item.title) }}
                    >
                      {item.title?.[0] || '?'}
                    </div>
                  )}
                  {percent > 0 && (
                    <div className="library-card__progress-bar">
                      <div
                        className="library-card__progress-fill"
                        style={{ width: `${Math.round(percent * 100)}%` }}
                      />
                    </div>
                  )}
                </LocalizedLink>
                <div className="library-card__info">
                  <div className="library-card__text">
                    <LocalizedLink to={`/books/${item.slug}`} className="library-card__title">
                      {item.title}
                    </LocalizedLink>
                    {percent > 0 && progress?.chapterSlug && (
                      <LocalizedLink
                        to={`/books/${item.slug}/${progress.chapterSlug}`}
                        className="library-card__continue"
                      >
                        Continue · {Math.round(percent * 100)}%
                      </LocalizedLink>
                    )}
                    {percent > 0 && !progress?.chapterSlug && (
                      <span className="library-card__progress-text">
                        {Math.round(percent * 100)}% read
                      </span>
                    )}
                  </div>
                  <button
                    className="library-card__remove"
                    onClick={() => remove(item.editionId)}
                    title="Remove from library"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
