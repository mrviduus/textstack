import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { getUserBookCoverUrl, type UserBook } from '../../api/userBooks'
import { useLanguage } from '../../context/LanguageContext'
import { BookStatusBadge } from './BookStatusBadge'
import { GeneratedCover } from './GeneratedCover'
import { BookActionMenu } from './BookActionMenu'
import { TagPill } from './TagPill'
import { SuggestedTagsPopover } from './SuggestedTagsPopover'
import { useTranslation } from '../../hooks/useTranslation'
import { useReadingPace } from '../../hooks/useReadingPace'
import { estimateMinutesRemaining, formatTimeLeft } from '../../lib/timeEstimate'

const NEW_BADGE_TTL_MS = 24 * 60 * 60 * 1000

interface UserBookCardProps {
  book: UserBook
  onDelete: () => void
  onRetry?: () => void
  onCancel?: () => void
  onUpdate?: () => void
  progress?: { percent: number | null; chapterSlug: string | null; updatedAt: string | null }
  highlighted?: boolean
  selectable?: boolean
  selected?: boolean
  onSelectToggle?: (id: string) => void
  excerpt?: string | null
  excerptChapterSlug?: string | null
  excerptQuery?: string
}

function formatElapsed(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

function isNew(createdAt: string): boolean {
  const t = new Date(createdAt).getTime()
  if (!t) return false
  return Date.now() - t < NEW_BADGE_TTL_MS
}

// User-uploaded book text is rendered as plain HTML excerpt; allow only <mark>.
function sanitizeExcerpt(raw: string): string {
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/&lt;mark&gt;/g, '<mark>')
    .replace(/&lt;\/mark&gt;/g, '</mark>')
}

export function UserBookCard({ book, onDelete, onRetry, onCancel, onUpdate, progress, highlighted, selectable, selected, onSelectToggle, excerpt, excerptChapterSlug, excerptQuery }: UserBookCardProps) {
  const { language } = useLanguage()
  const { t } = useTranslation()
  const pace = useReadingPace()
  const percent = progress?.percent ?? 0
  const [elapsed, setElapsed] = useState(0)
  const [suggestedOpen, setSuggestedOpen] = useState(false)
  const [, setSearchParams] = useSearchParams()
  const filterByTag = (tag: string) => {
    setSearchParams((prev) => {
      const sp = new URLSearchParams(prev)
      sp.set('tab', 'uploads')
      sp.set('q', `tag:${tag}`)
      return sp
    }, { replace: false })
  }

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

  const onChange = () => {
    onUpdate?.()
    onRetry?.()
    onCancel?.()
    onDelete()
  }

  const isReady = book.status === 'Ready'
  const isFailed = book.status === 'Failed'
  const isStuck = isProcessing && elapsed > 30

  // Readability is DERIVED (ADR-012): a PDF opens in Original layout the instant
  // its file exists, regardless of extraction status. So Processing/Failed on a
  // PDF is NOT a blocker — the card stays a live link.
  const hasOriginalPdf = !!book.hasOriginalPdf
  const readable = isReady || hasOriginalPdf

  const targetSlug = excerptChapterSlug || progress?.chapterSlug
  const readerBase = `/${language}/library/my/${book.id}`
  // Where "Continue" goes: straight into the text at the reader's position.
  const continueHref = !readable
    ? '#'
    : targetSlug
      ? `${readerBase}/read/${targetSlug}`      // resume a known chapter/progress
      : hasOriginalPdf
        ? `${readerBase}/read`                   // chapterless Original (instant read)
        : readerBase
  // The card itself opens the book's page — cover, description, chapters, its own Continue — rather
  // than dropping the reader into the text with no idea what they opened. The one exception is a
  // search hit: clicking a matched excerpt means "show me that place", so it still goes to the text.
  const isSearchHit = !!(excerpt && excerptQuery && isReady)
  const destination = !readable
    ? '#'
    : isSearchHit
      ? `${continueHref}?find=${encodeURIComponent(excerptQuery!)}`
      : readerBase
  const hasPosition = percent > 0 || !!progress?.chapterSlug
  const showContinue = readable && hasPosition && !book.completedAt && !isSearchHit

  const cardClasses = [
    'user-book-card',
    highlighted ? 'user-book-card--highlighted' : '',
    selectable ? 'user-book-card--selectable' : '',
    selected ? 'user-book-card--selected' : '',
  ].filter(Boolean).join(' ')

  const onCardClickCapture = (e: React.MouseEvent) => {
    if (!selectable || !onSelectToggle) return
    e.preventDefault()
    e.stopPropagation()
    onSelectToggle(book.id)
  }

  return (
    <div className={cardClasses} data-book-id={book.id} onClickCapture={onCardClickCapture}>
      {selectable && (
        <label className="user-book-card__check" onClick={(e) => e.stopPropagation()}>
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onSelectToggle?.(book.id)}
            aria-label={`Select ${book.title}`}
          />
        </label>
      )}
      <div className="user-book-card__cover-wrap">
        <Link
          to={destination}
          className={`user-book-card__cover ${!readable ? 'user-book-card__cover--disabled' : ''}`}
          onClick={(e) => !readable && e.preventDefault()}
        >
          {book.coverPath ? (
            <img
              src={getUserBookCoverUrl(book.coverPath)}
              alt={book.title}
              loading="lazy"
              onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextElementSibling?.classList.remove('hidden') }}
            />
          ) : null}
          <GeneratedCover
            title={book.title || '?'}
            author={book.author}
            className={book.coverPath ? 'hidden' : ''}
          />

          {/* readable = isReady || hasOriginalPdf → a PDF still Processing/Failed
              (per S1) can render page-% too, not just fully-extracted books. */}
          {readable && !book.completedAt && percent > 0 && (
            <div className="user-book-card__progress-bar">
              <div
                className="user-book-card__progress-fill"
                style={{ width: `${Math.round(percent * 100)}%` }}
              />
            </div>
          )}
        </Link>

        <div className="user-book-card__badges">
          {isProcessing && (
            hasOriginalPdf ? (
              // Readable PDF still extracting — quiet "Indexing…" hint, not a blocker.
              <BookStatusBadge variant="indexing" title={t('library.badge.indexingHint')} />
            ) : (
              <BookStatusBadge
                variant="processing"
                title={`${formatElapsed(elapsed)}${isStuck ? ' — possible issue' : ''}`}
              />
            )
          )}
          {/* Failed extraction on a readable PDF is NOT scary — the book still
              opens in Original; only text features (search/TOC) are gone. */}
          {isFailed && !hasOriginalPdf && (
            <BookStatusBadge
              variant="failed"
              title={book.errorMessage || 'Tap to retry'}
            />
          )}
          {isReady && !book.completedAt && isNew(book.createdAt) && (
            <BookStatusBadge variant="new" />
          )}
        </div>

        {isReady && book.completedAt && (
          <div className="user-book-card__finished-badge" aria-label="Read">
            <BookStatusBadge variant="finished" />
          </div>
        )}
      </div>

      <div className="user-book-card__info">
        <div className="user-book-card__text">
          <Link
            to={destination}
            className="user-book-card__title"
            title={book.title}
            onClick={(e) => !readable && e.preventDefault()}
          >
            {book.title}
          </Link>
          {book.author && (
            <div className="user-book-card__author" title={book.author}>{book.author}</div>
          )}
          {excerpt && (
            <div
              className="user-book-card__excerpt"
              dangerouslySetInnerHTML={{ __html: sanitizeExcerpt(excerpt) }}
            />
          )}
          {book.tags && book.tags.length > 0 && (
            <div className="user-book-card__tags">
              {book.tags.slice(0, 4).map((tag) => (
                <TagPill key={tag} tag={tag} onClick={() => filterByTag(tag)} />
              ))}
              {book.tags.length > 4 && (
                <span className="user-book-card__tags-more">+{book.tags.length - 4}</span>
              )}
            </div>
          )}
          {isReady && book.suggestedTags && book.suggestedTags.length > 0 && (!book.tags || book.tags.length === 0) && (
            <div className="user-book-card__suggested-wrap">
              <button
                type="button"
                className="user-book-card__suggested-pill"
                onClick={(e) => { e.stopPropagation(); setSuggestedOpen((v) => !v) }}
                aria-haspopup="dialog"
                aria-expanded={suggestedOpen}
              >
                ✨ {book.suggestedTags.length} suggested
              </button>
              {suggestedOpen && (
                <SuggestedTagsPopover
                  bookId={book.id}
                  suggestions={book.suggestedTags}
                  existingTags={book.tags ?? []}
                  onClose={() => setSuggestedOpen(false)}
                  onApplied={() => onUpdate?.()}
                />
              )}
            </div>
          )}
          <div className="user-book-card__meta">
            {isReady && book.completedAt && (
              <span className="user-book-card__progress-text user-book-card__progress-text--done">Read</span>
            )}
            {readable && !book.completedAt && percent > 0 && (
              <span className="user-book-card__progress-text">{Math.round(percent * 100)}% read</span>
            )}
            {isReady && !book.completedAt && book.chapterCount > 0 && percent === 0 && (
              <span>{book.chapterCount} chapters</span>
            )}
            {isReady && !book.completedAt && (() => {
              const minutes = estimateMinutesRemaining(
                { totalWordCount: book.totalWordCount, progressPercent: percent },
                pace.wpm,
              )
              if (minutes == null || minutes === 0) return null
              return (
                <span
                  className="user-book-card__time-left"
                  title={pace.isUserSpecific ? t('library.estimate.fromYourPace') : t('library.estimate.fallback')}
                >
                  · {t('library.estimate.left', { time: formatTimeLeft(minutes) })}
                </span>
              )
            })()}
            {isFailed && !hasOriginalPdf && book.errorMessage && (
              <span className="user-book-card__error" title={book.errorMessage}>
                {book.errorMessage.length > 40
                  ? book.errorMessage.slice(0, 40) + '...'
                  : book.errorMessage}
              </span>
            )}
          </div>
          {showContinue && (
            <Link to={continueHref} className="library-continue">
              {t('library.continue')}
            </Link>
          )}
        </div>

        <BookActionMenu type="userbook" book={book} onChange={onChange} />
      </div>
    </div>
  )
}
