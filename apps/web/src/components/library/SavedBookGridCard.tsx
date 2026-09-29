// Saved (catalog) book card in the library grid view. Extracted verbatim from
// LibraryPage.tsx (R6 slice-1) — presentational; `key` stays at the call site.
import { Link } from 'react-router-dom'
import { getStorageUrl } from '../../api/client'
import type { LibraryItem, ReadingProgressDto } from '../../api/auth'
import { OfflineBadge } from '../OfflineBadge'
import { BookActionMenu } from './BookActionMenu'
import { stringToColor } from '../../utils/colors'

export function SavedBookGridCard({
  item,
  progress,
  t,
  onRemove,
  onMarkFinished,
  onMarkUnfinished,
}: {
  item: LibraryItem
  progress: ReadingProgressDto | undefined
  t: (key: string) => string
  onRemove: () => void
  onMarkFinished: () => void
  onMarkUnfinished: () => void
}) {
  const percent = progress?.percent ?? 0
  // Recorded completion beats a threshold guess. `percent >= 1` was one of four
  // different answers to "is this finished?" before editions had the field.
  const isFinished = progress?.completedAt != null || percent >= 1
  // The card opens the book's page; "Continue" goes straight into the text.
  const destination = `/${item.language}/books/${item.slug}`
  const continueHref = progress?.chapterSlug ? `${destination}/${progress.chapterSlug}` : null
  const showContinue = !!continueHref && !isFinished
  return (
    <div className="library-card">
      <Link to={destination} className="library-card__cover" title={`Read ${item.title} online`}>
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
        {isFinished && (
          <div className="user-book-card__completed-badge">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Read
          </div>
        )}
        {percent > 0 && !isFinished && (
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
          <Link to={destination} className="library-card__title" title={item.title}>
            {item.title}
          </Link>
          {item.author && (
            <span className="user-book-card__author" title={item.author}>{item.author}</span>
          )}
          <div className="library-card__meta">
            {isFinished && (
              <span className="user-book-card__progress-text user-book-card__progress-text--done">Read</span>
            )}
            {percent > 0 && !isFinished && (
              <span className="library-card__progress-text">
                {Math.round(percent * 100)}% {t('library.read')}
              </span>
            )}
            <OfflineBadge editionId={item.editionId} />
          </div>
          {showContinue && (
            <Link to={continueHref!} className="library-continue">{t('library.continue')}</Link>
          )}
        </div>
        <BookActionMenu
          type="saved"
          book={item}
          isFinished={isFinished}
          onRemove={onRemove}
          onMarkFinished={onMarkFinished}
          onMarkUnfinished={onMarkUnfinished}
        />
      </div>
    </div>
  )
}
