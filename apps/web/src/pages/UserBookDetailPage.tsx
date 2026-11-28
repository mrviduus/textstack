import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import type { UserBookDetail } from '../api/userBooks'
import { platform } from '../platform'
import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import { stringToColor } from '../utils/colors'
import { BookInsightsSection } from '../components/library/BookInsightsSection'
import { AssistantMenu } from '../components/library/AssistantMenu'
import { currentReviewChapter, bookPages, plural } from '@textstack/shared'
import { useBookReviews } from '../hooks/useBookReviews'
import { emitDataChanges } from '../lib/dataEvents'
import { useCoverRetry } from '../hooks/useCoverRetry'

interface SavedProgress {
  chapterSlug?: string
  chapterNumber?: number // legacy format
  page: number
  percent: number
}

export function UserBookDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { isAuthenticated } = useAuth()
  const { language } = useLanguage()
  const [book, setBook] = useState<UserBookDetail | null>(null)
  const [coverHidden, onCoverError, coverSrc] = useCoverRetry(platform.library.getUserBookCoverUrl(book?.coverPath))
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  // Inline two-stage confirm — mirrors VocabularyPage's delete pattern.
  // First click flips the icon button into a red "Confirm?" pill; a second
  // click within 3 s actually deletes. Avoids the browser-native confirm()
  // popup and the prior loud red-circle visual.
  const [pendingDelete, setPendingDelete] = useState(false)
  const pendingTimeoutRef = useRef<number | null>(null)
  const { reviews, insights } = useBookReviews(isAuthenticated && book?.hasFile ? { userBookId: book.id } : null)

  // The server's position is the truth (the library card already shows it); localStorage only
  // knows what THIS browser read, so on any other device a 44%-read book said "Start Reading" and
  // the Assistant menu had no current chapter.
  const [serverProgress, setServerProgress] = useState<{ chapterSlug: string | null; percent: number | null } | null>(null)
  useEffect(() => {
    if (!id || !isAuthenticated) return
    let live = true
    platform.library.getUserBookProgress(id).then(p => { if (live) setServerProgress(p) })
    return () => { live = false }
  }, [id, isAuthenticated])

  const savedProgress = useMemo((): SavedProgress | null => {
    if (!id) return null
    if (serverProgress?.chapterSlug) {
      return { chapterSlug: serverProgress.chapterSlug, page: 0, percent: serverProgress.percent ?? 0 }
    }
    try {
      const stored = localStorage.getItem(`userbook.progress.${id}`)
      if (!stored) return null
      return JSON.parse(stored) as SavedProgress
    } catch {
      return null
    }
  }, [id, serverProgress])

  // Determine continue reading target
  const continueReadingSlug = useMemo(() => {
    if (!savedProgress || !book?.chapters) return null

    // New format: chapterSlug
    if (savedProgress.chapterSlug) {
      const chapter = book.chapters.find(c => c.slug === savedProgress.chapterSlug)
      if (chapter) return chapter.slug || String(chapter.chapterNumber)
    }

    // Legacy format: chapterNumber
    if (savedProgress.chapterNumber) {
      const chapter = book.chapters.find(c => c.chapterNumber === savedProgress.chapterNumber)
      if (chapter) return chapter.slug || String(chapter.chapterNumber)
    }

    return null
  }, [savedProgress, book?.chapters])

  useEffect(() => {
    if (!id || !isAuthenticated) return

    let cancelled = false
    setLoading(true)
    setError(null)

    platform.library.getUserBook(id)
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

  const handleDelete = async () => {
    if (!id || deleting) return

    // First click: arm the confirm. Second click within 3 s actually deletes.
    if (!pendingDelete) {
      setPendingDelete(true)
      if (pendingTimeoutRef.current) window.clearTimeout(pendingTimeoutRef.current)
      pendingTimeoutRef.current = window.setTimeout(() => setPendingDelete(false), 3000)
      return
    }

    if (pendingTimeoutRef.current) window.clearTimeout(pendingTimeoutRef.current)
    setDeleting(true)
    try {
      await platform.library.deleteUserBook(id)
      // LibraryPage + shelves listen to these and refresh on arrival.
      emitDataChanges(['user-books', 'shelves'])
      navigate(`/${language}/library`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete')
      setDeleting(false)
      setPendingDelete(false)
    }
  }

  // Clear the confirm timer on unmount so a stray state update can't fire
  // after navigation away from this page.
  useEffect(() => () => {
    if (pendingTimeoutRef.current) window.clearTimeout(pendingTimeoutRef.current)
  }, [])

  if (!isAuthenticated) {
    return (
      <>
      <div className="user-book-detail">
        <SeoHead title="My Book" noindex />
        <div className="user-book-detail__empty">
          <p>Sign in to view your uploaded books.</p>
        </div>
      </div>
      <Footer />
      </>
    )
  }

  if (loading) {
    return (
      <>
      <div className="user-book-detail">
        <SeoHead title="Loading..." noindex />
        <div className="user-book-detail__loading">Loading...</div>
      </div>
      <Footer />
      </>
    )
  }

  if (error || !book) {
    return (
      <>
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
      <Footer />
      </>
    )
  }

  const hasOriginalPdf = !!book.hasOriginalPdf
  const pages = bookPages(book)
  // The reader opens the file itself once its bytes are in (ADR-033).
  const canRead = !!book.hasFile
  const readerBase = `/${language}/library/my/${book.id}`
  const readHref = continueReadingSlug
    ? `${readerBase}/read/${continueReadingSlug}`
    : hasOriginalPdf
      ? `${readerBase}/read` // chapterless Original (instant read)
      : book.chapters.length > 0
        ? `${readerBase}/read/${book.chapters[0].slug || book.chapters[0].chapterNumber}`
        : `${readerBase}/read`

  return (
    <>
    <div className="user-book-detail">
      <SeoHead title={book.title} noindex />

      <div className="user-book-detail__header">
        <Link to={`/${language}/library`} className="user-book-detail__back-link">
          ← Back to Library
        </Link>
      </div>

      <div className="user-book-detail__content">
        <div className="user-book-detail__cover">
          {!coverHidden ? (
            <img src={coverSrc} alt={book.title} onError={onCoverError} />
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

          {book.author && (
            <p className="user-book-detail__author">{book.author}</p>
          )}

          {book.description && (
            <p className="user-book-detail__description">{book.description}</p>
          )}

          <div className="user-book-detail__meta">
            <span>Language: {book.language}</span>
            {book.genre && <span>{book.genre}</span>}
            {book.publishedYear && <span>{book.publishedYear}</span>}
            {pages && (
              <span>{plural(pages.pages, 'page', 'pages', `${pages.exact ? '' : '~'}${pages.pages.toLocaleString()} {noun}`)}</span>
            )}
          </div>

          {canRead && book.completedAt && (
            <div className="user-book-detail__completed">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Read
            </div>
          )}

          <div className="user-book-detail__actions">
            {canRead && (
              <Link
                to={readHref}
                className="user-book-detail__read-btn"
              >
                {continueReadingSlug ? 'Continue Reading' : 'Start Reading'}
              </Link>
            )}

            {/* The book's own contents, in the reader (its Contents panel opens with the book). */}
            {canRead && (
              <Link to={`${readerBase}/read?contents=1`} className="user-book-detail__mark-btn">
                Contents
              </Link>
            )}

            {canRead && (
              <AssistantMenu
                book={{
                  title: book.title,
                  author: book.author,
                  bookId: book.id,
                  progressFraction: savedProgress?.percent ?? null,
                  chapterTitle: book.chapters.find(c => c.slug === continueReadingSlug)?.title ?? null,
                }}
                current={currentReviewChapter(book.chapters, continueReadingSlug, reviews)}
              />
            )}

            {/* Completion is written on the reading place, so a book with no chapter yet has none to mark. */}
            {canRead && !book.completedAt && book.chapters.length > 0 && (
              <button
                onClick={async () => {
                  if ((await platform.library.markUserBookComplete(book.id)) === 'dropped') return
                  setBook({ ...book, completedAt: new Date().toISOString() })
                }}
                className="user-book-detail__mark-btn"
              >
                Mark as read
              </button>
            )}

            {canRead && book.completedAt && (
              <button
                onClick={async () => {
                  if ((await platform.library.unmarkUserBookComplete(book.id)) === 'dropped') return
                  setBook({ ...book, completedAt: null })
                }}
                className="user-book-detail__mark-btn"
              >
                Mark as unread
              </button>
            )}

            {/* The file you uploaded, not a link: this page is private, so a shared URL opened a
                login wall for whoever received it (mobile made the same change). */}
            {canRead && (
              <a
                className="user-book-detail__reextract-icon"
                href={platform.library.getUserBookFileUrl(book.id)}
                download
                aria-label="Download the file you uploaded"
                title="Download the file you uploaded"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </a>
            )}

            {canRead && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className={`user-book-detail__delete-icon${pendingDelete ? ' user-book-detail__delete-icon--confirming' : ''}`}
                aria-label={deleting ? 'Deleting…' : pendingDelete ? 'Click again to confirm delete' : 'Delete this book'}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6" />
                  <path d="M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
                {pendingDelete && <span className="user-book-detail__delete-icon__confirm-label">Confirm?</span>}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Coming back to a book, what you already worked out. */}
      {canRead && book && (
        <BookInsightsSection insights={insights} />
      )}

    </div>
    <Footer />
    </>
  )
}
