// Saved (catalog) book row in the library list view. Extracted verbatim from
// LibraryPage.tsx (R6 slice-1) — presentational; `key` stays at the call site.
import { Link } from 'react-router-dom'
import { getStorageUrl } from '../../api/client'
import type { LibraryItem, ReadingProgressDto } from '../../api/auth'
import { OfflineBadge } from '../OfflineBadge'
import { BookActionMenu } from './BookActionMenu'
import { stringToColor } from '../../utils/colors'
import { formatTimeAgo } from './timeAgo'

export function SavedBookListItem({
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
  // The row opens the book's page; "Continue" goes straight into the text.
  const destination = `/${item.language}/books/${item.slug}`
  const continueHref = progress?.chapterSlug ? `${destination}/${progress.chapterSlug}` : null
  const showContinue = !!continueHref && !isFinished
  return (
    <article className="library-list-item">
      <Link to={destination} className="library-list-item__cover">
        {item.coverPath ? (
          <img src={getStorageUrl(item.coverPath)} alt={item.title} />
        ) : (
          <div
            className="library-list-item__cover-placeholder"
            style={{ backgroundColor: stringToColor(item.title) }}
          >
            {item.title?.[0] || '?'}
          </div>
        )}
      </Link>
      <div className="library-list-item__content">
        <Link to={destination} className="library-list-item__title" title={item.title}>
          {item.title}
        </Link>
        <div className="library-list-item__progress">
          <div className="library-list-item__progress-header">
            <span>{t('library.readingProgress')}</span>
            <span className="library-list-item__progress-percent">{Math.round(percent * 100)}%</span>
          </div>
          <div className="library-list-item__progress-bar">
            <div
              className="library-list-item__progress-fill"
              style={{ width: `${Math.round(percent * 100)}%` }}
            />
          </div>
        </div>
        <div className="library-list-item__info">
          {item.author && (
            <span className="library-list-item__info-item" title={item.author}>{item.author}</span>
          )}
          {progress?.updatedAt && (
            <span className="library-list-item__info-item">
              <span className="material-icons-outlined">schedule</span>
              {t('library.lastRead')} {formatTimeAgo(progress.updatedAt, t)}
            </span>
          )}
          <OfflineBadge editionId={item.editionId} />
        </div>
      </div>
      <div className="library-list-item__actions">
        {showContinue && (
          <Link to={continueHref!} className="library-continue">{t('library.continue')}</Link>
        )}
        <BookActionMenu
          type="saved"
          book={item}
          isFinished={isFinished}
          onRemove={onRemove}
          onMarkFinished={onMarkFinished}
          onMarkUnfinished={onMarkUnfinished}
        />
      </div>
    </article>
  )
}
