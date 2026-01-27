import { useState, useRef, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { deleteUserBook, retryUserBook, cancelUserBook, getUserBookCoverUrl, type UserBook } from '../../api/userBooks'
import { stringToColor } from '../../utils/colors'
import { useLanguage } from '../../context/LanguageContext'

interface UserBookCardProps {
  book: UserBook
  onDelete: () => void
  onRetry?: () => void
  onCancel?: () => void
}

function formatElapsed(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

export function UserBookCard({ book, onDelete, onRetry, onCancel }: UserBookCardProps) {
  const { language } = useLanguage()
  const [menuOpen, setMenuOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const menuRef = useRef<HTMLDivElement>(null)

  const isProcessing = book.status === 'Processing'

  // Track elapsed time for processing books
  useEffect(() => {
    if (!isProcessing) return

    const startTime = new Date(book.createdAt).getTime()
    const updateElapsed = () => {
      setElapsed(Math.floor((Date.now() - startTime) / 1000))
    }

    updateElapsed()
    const timer = setInterval(updateElapsed, 1000)
    return () => clearInterval(timer)
  }, [isProcessing, book.createdAt])

  // Close menu on click outside
  useEffect(() => {
    if (!menuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [menuOpen])

  const handleDelete = async () => {
    if (deleting) return
    setDeleting(true)
    try {
      await deleteUserBook(book.id)
      onDelete()
    } catch (err) {
      console.error('Failed to delete book:', err)
    } finally {
      setDeleting(false)
      setMenuOpen(false)
    }
  }

  const handleRetry = async () => {
    if (retrying) return
    setRetrying(true)
    try {
      await retryUserBook(book.id)
      onRetry?.()
    } catch (err) {
      console.error('Failed to retry book:', err)
    } finally {
      setRetrying(false)
      setMenuOpen(false)
    }
  }

  const handleCancel = async () => {
    if (cancelling) return
    setCancelling(true)
    try {
      await cancelUserBook(book.id)
      onCancel?.()
    } catch (err) {
      console.error('Failed to cancel book:', err)
    } finally {
      setCancelling(false)
      setMenuOpen(false)
    }
  }

  const isReady = book.status === 'Ready'
  const isFailed = book.status === 'Failed'
  const isStuck = isProcessing && elapsed > 180 // 3 minutes

  const destination = isReady ? `/${language}/library/my/${book.id}` : '#'

  return (
    <div className="user-book-card">
      <Link
        to={destination}
        className={`user-book-card__cover ${!isReady ? 'user-book-card__cover--disabled' : ''}`}
        onClick={(e) => !isReady && e.preventDefault()}
      >
        {book.coverPath ? (
          <img src={getUserBookCoverUrl(book.coverPath)} alt={book.title} />
        ) : (
          <div
            className="user-book-card__cover-placeholder"
            style={{ backgroundColor: stringToColor(book.title) }}
          >
            {book.title?.[0] || '?'}
          </div>
        )}

        {isProcessing && (
          <div className={`user-book-card__status user-book-card__status--processing${isStuck ? ' user-book-card__status--stuck' : ''}`}>
            <span className="user-book-card__spinner" />
            Processing... {formatElapsed(elapsed)}
            {isStuck && <span className="user-book-card__stuck-warning">Possible issue</span>}
          </div>
        )}

        {isFailed && (
          <div className="user-book-card__status user-book-card__status--failed">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/>
            </svg>
            Failed
          </div>
        )}
      </Link>

      <div className="user-book-card__info">
        <div className="user-book-card__text">
          <Link
            to={destination}
            className="user-book-card__title"
            onClick={(e) => !isReady && e.preventDefault()}
          >
            {book.title}
          </Link>
          <div className="user-book-card__meta">
            {isReady && book.chapterCount > 0 && (
              <span>{book.chapterCount} chapters</span>
            )}
            {isFailed && book.errorMessage && (
              <span className="user-book-card__error" title={book.errorMessage}>
                {book.errorMessage.length > 40
                  ? book.errorMessage.slice(0, 40) + '...'
                  : book.errorMessage}
              </span>
            )}
          </div>
        </div>

        <div className="user-book-card__menu" ref={menuRef}>
          <button
            className="user-book-card__menu-trigger"
            onClick={() => setMenuOpen((v) => !v)}
            aria-haspopup="true"
            aria-expanded={menuOpen}
            title="Options"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="2" />
              <circle cx="12" cy="12" r="2" />
              <circle cx="12" cy="19" r="2" />
            </svg>
          </button>

          {menuOpen && (
            <div className="user-book-card__dropdown" role="menu">
              {isReady && (
                <Link
                  to={`/${language}/library/my/${book.id}`}
                  className="user-book-card__item"
                  role="menuitem"
                  onClick={() => setMenuOpen(false)}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                    <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                  </svg>
                  View details
                </Link>
              )}

              {isFailed && (
                <button
                  className="user-book-card__item"
                  onClick={handleRetry}
                  disabled={retrying}
                  role="menuitem"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M23 4v6h-6M1 20v-6h6" />
                    <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
                  </svg>
                  {retrying ? 'Retrying...' : 'Retry'}
                </button>
              )}

              {isProcessing && (
                <button
                  className="user-book-card__item user-book-card__item--danger"
                  onClick={handleCancel}
                  disabled={cancelling}
                  role="menuitem"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M15 9l-6 6M9 9l6 6" />
                  </svg>
                  {cancelling ? 'Cancelling...' : 'Cancel'}
                </button>
              )}

              <button
                className="user-book-card__item user-book-card__item--danger"
                onClick={handleDelete}
                disabled={deleting}
                role="menuitem"
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
