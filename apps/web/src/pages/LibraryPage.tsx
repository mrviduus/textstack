import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLibrary } from '../hooks/useLibrary'
import { useApi } from '../hooks/useApi'
import { LocalizedLink } from '../components/LocalizedLink'
import { SeoHead } from '../components/SeoHead'
import { OfflineBadge } from '../components/OfflineBadge'
import { BookCardMenu } from '../components/library/BookCardMenu'
import { getStorageUrl } from '../api/client'
import { stringToColor } from '../utils/colors'
import { getAllProgress, ReadingProgressDto, markAsRead, markAsUnread } from '../api/auth'

export function LibraryPage() {
  const { isAuthenticated, user } = useAuth()
  const { items, loading, remove } = useLibrary()
  const api = useApi()
  const [progressMap, setProgressMap] = useState<Record<string, ReadingProgressDto>>({})

  // Mark book as read (fetch first chapter, set 100%)
  const handleMarkRead = useCallback(async (editionId: string, slug: string) => {
    try {
      const book = await api.getBook(slug)
      if (book.chapters.length === 0) return
      const lastChapter = book.chapters[book.chapters.length - 1]
      const result = await markAsRead(editionId, lastChapter.id)
      setProgressMap(prev => ({ ...prev, [editionId]: result }))
    } catch (err) {
      console.error('Failed to mark as read:', err)
    }
  }, [api])

  // Mark book as unread (set 0%)
  const handleMarkUnread = useCallback(async (editionId: string, slug: string) => {
    try {
      const book = await api.getBook(slug)
      if (book.chapters.length === 0) return
      const firstChapter = book.chapters[0]
      const result = await markAsUnread(editionId, firstChapter.id)
      setProgressMap(prev => ({ ...prev, [editionId]: result }))
    } catch (err) {
      console.error('Failed to mark as unread:', err)
    }
  }, [api])

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
          <LocalizedLink to="/books" className="library-page__browse-btn" title="Browse all books">
            Browse Books
          </LocalizedLink>
        </div>
      ) : (
        <div className="library-page__grid">
          {items.map((item) => {
            const progress = progressMap[item.editionId]
            const percent = progress?.percent ?? 0
            const destination = progress?.chapterSlug
              ? `/${item.language}/books/${item.slug}/${progress.chapterSlug}`
              : `/${item.language}/books/${item.slug}`
            return (
              <div key={item.editionId} className="library-card">
                <Link to={destination} className="library-card__cover" title={`Read ${item.title} online`}>
                  {item.coverPath ? (
                    <img src={getStorageUrl(item.coverPath)} alt={item.title} title={`${item.title} - Read online free`} />
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
                </Link>
                <div className="library-card__info">
                  <div className="library-card__text">
                    <Link to={destination} className="library-card__title" title={`Read ${item.title} online`}>
                      {item.title}
                    </Link>
                    <div className="library-card__meta">
                      {percent > 0 && (
                        <span className="library-card__progress-text">
                          {Math.round(percent * 100)}% read
                        </span>
                      )}
                      <OfflineBadge editionId={item.editionId} />
                    </div>
                  </div>
                  <BookCardMenu
                    book={item}
                    isRead={percent >= 1}
                    onRemove={() => remove(item.editionId)}
                    onMarkRead={() => handleMarkRead(item.editionId, item.slug)}
                    onMarkUnread={() => handleMarkUnread(item.editionId, item.slug)}
                  />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
