import { Link, useSearchParams } from 'react-router-dom'
import type { UserBook } from '../../api/userBooks'
import { platform } from '../../platform'
import { useLanguage } from '../../context/LanguageContext'
import { BookStatusBadge } from './BookStatusBadge'
import { GeneratedCover } from './GeneratedCover'
import { BookActionMenu } from './BookActionMenu'
import { TagPill } from './TagPill'
import { useTranslation } from '../../hooks/useTranslation'
import { useReadingPace } from '../../hooks/useReadingPace'
import { useCoverRetry } from '../../hooks/useCoverRetry'
import { formatTimeLeft } from '../../lib/timeEstimate'
import { bookMinutesLeft } from '@textstack/shared'

const NEW_BADGE_TTL_MS = 24 * 60 * 60 * 1000

interface UserBookCardProps {
  book: UserBook
  onDelete: () => void
  onUpdate?: () => void
  progress?: { percent: number | null; chapterSlug: string | null; updatedAt: string | null }
  highlighted?: boolean
  selectable?: boolean
  selected?: boolean
  onSelectToggle?: (id: string) => void
}

function isNew(createdAt: string): boolean {
  const t = new Date(createdAt).getTime()
  if (!t) return false
  return Date.now() - t < NEW_BADGE_TTL_MS
}

export function UserBookCard({ book, onDelete, onUpdate, progress, highlighted, selectable, selected, onSelectToggle }: UserBookCardProps) {
  const { language } = useLanguage()
  const { t } = useTranslation()
  const pace = useReadingPace()
  const percent = progress?.percent ?? 0
  const [, setSearchParams] = useSearchParams()
  const filterByTag = (tag: string) => {
    setSearchParams((prev) => {
      const sp = new URLSearchParams(prev)
      sp.set('tab', 'uploads')
      sp.set('q', `tag:${tag}`)
      return sp
    }, { replace: false })
  }

  const onChange = () => {
    onUpdate?.()
    onDelete()
  }

  // Ready = the file's bytes are in: the reader parses the file itself (ADR-033).
  const readable = book.status === 'Ready'
  const hasOriginalPdf = !!book.hasOriginalPdf
  const coverUrl = platform.library.getUserBookCoverUrl(book.coverPath)
  const [coverHidden, onCoverError, coverSrc] = useCoverRetry(coverUrl)

  const targetSlug = progress?.chapterSlug
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
  // than dropping the reader into the text with no idea what they opened.
  const destination = !readable ? '#' : readerBase
  const hasPosition = percent > 0 || !!progress?.chapterSlug
  const showContinue = readable && hasPosition && !book.completedAt

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
          {!coverHidden ? (
            <img
              src={coverSrc}
              alt={book.title}
              loading="lazy"
              onError={onCoverError}
            />
          ) : null}
          <GeneratedCover
            title={book.title || '?'}
            author={book.author}
            className={coverHidden ? '' : 'hidden'}
          />

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
          {/* Failed = the file's bytes are gone. */}
          {!readable && <BookStatusBadge variant="failed" />}
          {readable && !book.completedAt && isNew(book.createdAt) && (
            <BookStatusBadge variant="new" />
          )}
        </div>

        {readable && book.completedAt && (
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
          <div className="user-book-card__meta">
            {readable && book.completedAt && (
              <span className="user-book-card__progress-text user-book-card__progress-text--done">Read</span>
            )}
            {readable && !book.completedAt && percent > 0 && (
              <span className="user-book-card__progress-text">{Math.round(percent * 100)}% read</span>
            )}
            {readable && !book.completedAt && book.chapterCount > 0 && percent === 0 && (
              <span>{book.chapterCount} chapters</span>
            )}
            {readable && !book.completedAt && (() => {
              const minutes = bookMinutesLeft(book.totalWordCount, percent, pace.wpm)
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
          </div>
          {showContinue && (
            <Link to={continueHref} className="library-continue">
              {t('library.continue')}
            </Link>
          )}
        </div>

        <BookActionMenu book={book} onChange={onChange} />
      </div>
    </div>
  )
}
