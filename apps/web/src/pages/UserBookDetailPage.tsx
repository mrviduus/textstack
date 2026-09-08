import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useLanguage } from '../context/LanguageContext'
import { getUserBook, deleteUserBook, retryUserBook, enrichUserBook, markUserBookComplete, unmarkUserBookComplete, getUserBookCoverUrl, type UserBookDetail } from '../api/userBooks'
import { SeoHead } from '../components/SeoHead'
import { Footer } from '../components/Footer'
import { stringToColor } from '../utils/colors'
import { ShareButtons } from '../components/ShareButtons'
import { BookStatsSection } from '../components/library/BookStatsSection'
import { BookInsightsSection } from '../components/library/BookInsightsSection'
import { DiscussWithAssistant } from '../components/library/DiscussWithAssistant'
import { emitDataChanges } from '../lib/dataEvents'
import { AddToCollectionButton } from '../components/library/AddToCollectionButton'
import { useTranslation } from '../hooks/useTranslation'

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
  const { t } = useTranslation()
  const [book, setBook] = useState<UserBookDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [reprocessing, setReprocessing] = useState(false)
  const [enriching, setEnriching] = useState(false)
  // Local, dismissible error for the enrich-retry action only. Kept SEPARATE
  // from the page-level `error` so a benign retry rejection (e.g. the sweep
  // already re-claimed the row → 400) never tears down the whole detail page.
  const [enrichError, setEnrichError] = useState<string | null>(null)
  // Inline two-stage confirm — mirrors VocabularyPage's delete pattern.
  // First click flips the icon button into a red "Confirm?" pill; a second
  // click within 3 s actually deletes. Avoids the browser-native confirm()
  // popup and the prior loud red-circle visual.
  const [pendingDelete, setPendingDelete] = useState(false)
  const pendingTimeoutRef = useRef<number | null>(null)

  // Get saved progress from localStorage
  const savedProgress = useMemo((): SavedProgress | null => {
    if (!id) return null
    try {
      const stored = localStorage.getItem(`userbook.progress.${id}`)
      if (!stored) return null
      return JSON.parse(stored) as SavedProgress
    } catch {
      return null
    }
  }, [id])

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

  // Auto-refresh while metadata enrichment is in flight. The existing poll above
  // stops at Ready (before enrichment runs), so this covers the Pending/Running
  // window — the worker can't reach the browser, so we poll until a terminal
  // state (Completed/Failed) and then stop.
  useEffect(() => {
    const s = book?.metadataEnrichmentStatus
    if (s !== 'Pending' && s !== 'Running') return
    // Cap the poll so a down worker can't leave us refetching forever. ~24
    // ticks × 5 s ≈ 2 min, then we give up (the badge keeps showing
    // "Generating…"); revisiting the page re-arms this effect and restarts it.
    let ticks = 0
    const MAX_TICKS = 24
    const interval = setInterval(() => {
      if (ticks >= MAX_TICKS) {
        clearInterval(interval)
        return
      }
      ticks += 1
      getUserBook(id!)
        .then(setBook)
        .catch(() => {})
    }, 5000)
    return () => clearInterval(interval)
  }, [book?.metadataEnrichmentStatus, id])

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
      await deleteUserBook(id)
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

  const isReady = book.status === 'Ready'
  const isProcessing = book.status === 'Processing'
  const isFailed = book.status === 'Failed'
  // Readability is DERIVED (ADR-012): a PDF opens in Original layout regardless
  // of extraction status, so Processing/Failed must not block or scare.
  const hasOriginalPdf = !!book.hasOriginalPdf
  const canRead = hasOriginalPdf || (isReady && book.chapters.length > 0)
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

          {book.author && (
            <p className="user-book-detail__author">{book.author}</p>
          )}

          {book.description && (
            <p className="user-book-detail__description">{book.description}</p>
          )}

          {/* Visible metadata-enrichment status. Only surfaced while work is in
              flight (Pending/Running) or after a failure — Completed/NotStarted/
              undefined render nothing so we don't nag on old rows or genuinely
              undescribable books. */}
          {(book.metadataEnrichmentStatus === 'Pending' || book.metadataEnrichmentStatus === 'Running') && (
            <div className="user-book-detail__enrich user-book-detail__enrich--running">
              <span className="user-book-detail__spinner user-book-detail__spinner--sm" />
              <span>{t('userBook.enriching')}</span>
            </div>
          )}

          {book.metadataEnrichmentStatus === 'Failed' && (
            <div className="user-book-detail__enrich user-book-detail__enrich--failed">
              <span>{t('userBook.enrichFailed')}</span>
              <button
                type="button"
                className="user-book-detail__enrich-retry"
                disabled={enriching}
                onClick={async () => {
                  if (!id || enriching) return
                  setEnriching(true)
                  setEnrichError(null)
                  // Optimistic: flip to Pending so the spinner shows immediately
                  // and the enrichment poll effect starts refetching.
                  setBook((prev) => (prev ? { ...prev, metadataEnrichmentStatus: 'Pending' } : prev))
                  try {
                    await enrichUserBook(id)
                  } catch (err) {
                    // The POST may have reached the server (row is now Pending)
                    // even though the response failed — blindly rolling back to
                    // Failed would halt the poll while the server enriches. So
                    // reconcile with the server's TRUE status via a refetch, and
                    // surface a LOCAL, dismissible error (never the page-level
                    // `error`, which renders a full-page "Book Not Found").
                    getUserBook(id)
                      .then(setBook)
                      .catch(() => {
                        // Refetch failed too — keep status at Pending so the poll
                        // keeps reconciling rather than forcing a stuck Failed.
                        setBook((prev) => (prev ? { ...prev, metadataEnrichmentStatus: 'Pending' } : prev))
                      })
                    setEnrichError(err instanceof Error ? err.message : 'Failed to generate details')
                  } finally {
                    setEnriching(false)
                  }
                }}
              >
                {t('userBook.enrichRetry')}
              </button>
            </div>
          )}

          {/* Local retry error — subtle, dismissible, and NEVER the page-level
              `error` (which renders a full-page "Book Not Found"). Clears on the
              next retry attempt / on success. */}
          {enrichError && (
            <div className="user-book-detail__enrich user-book-detail__enrich--failed" role="status">
              <span>{enrichError}</span>
              <button
                type="button"
                className="user-book-detail__enrich-retry"
                onClick={() => setEnrichError(null)}
                aria-label="Dismiss"
              >
                {t('common.dismiss')}
              </button>
            </div>
          )}

          <div className="user-book-detail__meta">
            <span>Language: {book.language}</span>
            {book.genre && <span>{book.genre}</span>}
            {book.publishedYear && <span>{book.publishedYear}</span>}
            {isReady && <span>{book.chapters.length} chapters</span>}
            {book.totalWordCount != null && book.totalWordCount > 0 && (
              <span>{Math.round(book.totalWordCount / 250).toLocaleString()} pages</span>
            )}
          </div>

          {/* A readable PDF is never blocked: while it indexes we show a quiet
              hint, and a failed extraction is NOT a scary block (ADR-012). */}
          {isProcessing && !hasOriginalPdf && (
            <div className="user-book-detail__status user-book-detail__status--processing">
              <span className="user-book-detail__spinner" />
              Processing... This may take a few minutes.
            </div>
          )}

          {isProcessing && hasOriginalPdf && (
            <div className="user-book-detail__status user-book-detail__status--indexing">
              {t('library.badge.indexingHint')}
            </div>
          )}

          {isFailed && !hasOriginalPdf && (
            <div className="user-book-detail__status user-book-detail__status--failed">
              <strong>Processing Failed</strong>
              {book.errorMessage && <p>{book.errorMessage}</p>}
            </div>
          )}

          {isReady && book.completedAt && (
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

            {isReady && !book.completedAt && (
              <button
                onClick={async () => {
                  await markUserBookComplete(book.id)
                  setBook({ ...book, completedAt: new Date().toISOString() })
                }}
                className="user-book-detail__mark-btn"
              >
                Mark as read
              </button>
            )}

            {isReady && book.completedAt && (
              <button
                onClick={async () => {
                  await unmarkUserBookComplete(book.id)
                  setBook({ ...book, completedAt: null })
                }}
                className="user-book-detail__mark-btn"
              >
                Mark as unread
              </button>
            )}

            {isReady && (
              <AddToCollectionButton
                variant="button"
                bookId={book.id}
                bookType="userbook"
                iconOnly
              />
            )}

            {isReady && (
              <ShareButtons
                url={window.location.href}
                title={book.title}
                subtitle={book.author || undefined}
                linkOnly
              />
            )}

            {isReady && (
              <button
                type="button"
                onClick={async () => {
                  if (!id || reprocessing) return
                  setReprocessing(true)
                  try {
                    await retryUserBook(id)
                    // Flip to Processing so the auto-refresh effect kicks in
                    // and the user sees the spinner instead of stale Ready state.
                    setBook({ ...book, status: 'Processing' })
                  } catch (err) {
                    setError(err instanceof Error ? err.message : 'Failed to reprocess')
                  } finally {
                    setReprocessing(false)
                  }
                }}
                disabled={reprocessing}
                className="user-book-detail__reextract-icon"
                aria-label={reprocessing ? 'Reprocessing…' : 'Re-extract this book (pick up extraction improvements)'}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="23 4 23 10 17 10" />
                  <polyline points="1 20 1 14 7 14" />
                  <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10" />
                  <path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14" />
                </svg>
              </button>
            )}

            {isReady && (
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

      {isReady && book && (
        <BookStatsSection bookId={book.id} />
      )}

      {/* Above the chapter list on purpose: coming back to a book, what you
          already worked out is more use than the table of contents. */}
      {isReady && book && (
        <BookInsightsSection userBookId={book.id} />
      )}

      {/* Directly under the insights: the section shows what came back, this is
          how you go and get more. */}
      {isReady && book && (
        <DiscussWithAssistant
          title={book.title}
          author={book.author}
          bookId={book.id}
          progressFraction={savedProgress?.percent ?? null}
          chapterTitle={
            book.chapters.find(c => c.slug === savedProgress?.chapterSlug)?.title ?? null
          }
        />
      )}

      {isReady && book.chapters.length > 0 && (
        <div className="user-book-detail__chapters">
          <h2>Chapters</h2>
          <ul className="user-book-detail__chapter-list">
            {book.chapters.map((chapter) => (
              <li key={chapter.id}>
                <Link to={`/${language}/library/my/${book.id}/read/${chapter.slug || chapter.chapterNumber}`}>
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
    <Footer />
    </>
  )
}
