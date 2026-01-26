import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { getUserBook, deleteUserBook, getUserBookCoverUrl, type UserBookDetail } from '../api/userBooks'
import { SeoHead } from '../components/SeoHead'
import { stringToColor } from '../utils/colors'

export function UserBookDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { isAuthenticated } = useAuth()
  const { language } = useLanguage()
  const [book, setBook] = useState<UserBookDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    if (!id || !isAuthenticated) return

    let cancelled = false
    setLoading(true)
    setError(null)

    getUserBook(id)
      .then((data) => {
        if (!cancelled) setBook(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [id, isAuthenticated])

  // Auto-refresh while processing
  useEffect(() => {
    if (!book || book.status !== 'Processing') return
    const interval = setInterval(() => {
      getUserBook(id!)
        .then(setBook)
        .catch(() => {})
    }, 5000)
    return () => clearInterval(interval)
  }, [book?.status, id])

  const handleDelete = async () => {
    if (!id || deleting) return
    if (!confirm('Are you sure you want to delete this book?')) return

    setDeleting(true)
    try {
      await deleteUserBook(id)
      navigate(`/${language}/library`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
      setDeleting(false)
    }
  }

  if (!isAuthenticated) {
    return (
      <div className="user-book-detail">
        <SeoHead title="My Book" noindex />
        <div className="user-book-detail__empty">
          <p>Sign in to view your uploaded books.</p>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="user-book-detail">
        <SeoHead title="Loading..." noindex />
        <div className="user-book-detail__loading">Loading...</div>
      </div>
    )
  }

  if (error || !book) {
    return (
      <div className="user-book-detail">
        <SeoHead title="Book Not Found" noindex />
        <div className="user-book-detail__error">
          <h2>Error</h2>
          <p>{error || 'Book not found'}</p>
          <Link to={`/${language}/library`} className="user-book-detail__back">
            Back to Library
          </Link>
        </div>
      </div>
    )
  }

  const isReady = book.status === 'Ready'
  const isProcessing = book.status === 'Processing'
  const isFailed = book.status === 'Failed'

  return (
    <div className="user-book-detail">
      <SeoHead title={book.title} noindex />

      <div className="user-book-detail__header">
        <Link to={`/${language}/library`} className="user-book-detail__back-link">
          ← Back to Library
        </Link>
      </div>

      <div className="user-book-detail__content">
        <div className="user-book-detail__cover">
          {book.coverPath ? (
            <img src={getUserBookCoverUrl(book.coverPath)} alt={book.title} />
          ) : (
            <div
              className="user-book-detail__cover-placeholder"
              style={{ backgroundColor: stringToColor(book.title) }}
            >
              {book.title?.[0] || '?'}
            </div>
          )}
        </div>

        <div className="user-book-detail__info">
          <h1 className="user-book-detail__title">{book.title}</h1>

          {book.description && (
            <p className="user-book-detail__description">{book.description}</p>
          )}

          <div className="user-book-detail__meta">
            <span>Language: {book.language}</span>
            {isReady && <span>{book.chapters.length} chapters</span>}
          </div>

          {isProcessing && (
            <div className="user-book-detail__status user-book-detail__status--processing">
              <span className="user-book-detail__spinner" />
              Processing... This may take a few minutes.
            </div>
          )}

          {isFailed && (
            <div className="user-book-detail__status user-book-detail__status--failed">
              <strong>Processing Failed</strong>
              {book.errorMessage && <p>{book.errorMessage}</p>}
            </div>
          )}

          <div className="user-book-detail__actions">
            {isReady && book.chapters.length > 0 && (
              <Link
                to={`/${language}/library/my/${book.id}/read/1`}
                className="user-book-detail__read-btn"
              >
                Start Reading
              </Link>
            )}

            <button
              onClick={handleDelete}
              disabled={deleting}
              className="user-book-detail__delete-btn"
            >
              {deleting ? 'Deleting...' : 'Delete Book'}
            </button>
          </div>
        </div>
      </div>

      {isReady && book.chapters.length > 0 && (
        <div className="user-book-detail__chapters">
          <h2>Chapters</h2>
          <ul className="user-book-detail__chapter-list">
            {book.chapters.map((chapter) => (
              <li key={chapter.id}>
                <Link to={`/${language}/library/my/${book.id}/read/${chapter.chapterNumber}`}>
                  <span className="user-book-detail__chapter-number">
                    {chapter.chapterNumber}.
                  </span>
                  <span className="user-book-detail__chapter-title">
                    {chapter.title}
                  </span>
                  {chapter.wordCount && (
                    <span className="user-book-detail__chapter-words">
                      {chapter.wordCount.toLocaleString()} words
                    </span>
                  )}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
