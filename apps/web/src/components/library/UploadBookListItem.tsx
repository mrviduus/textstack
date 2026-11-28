// Uploaded (user) book row in the library list view. Extracted verbatim from
// LibraryPage.tsx (R6 slice-1) — presentational; `key` stays at the call site.
import { Link } from 'react-router-dom'
import type { UserBook } from '../../api/userBooks'
import { platform } from '../../platform'
import { BookActionMenu } from './BookActionMenu'
import { useCoverRetry } from '../../hooks/useCoverRetry'
import { stringToColor } from '../../utils/colors'
import { formatTimeAgo } from '@textstack/shared'

export function UploadBookListItem({
  book,
  language,
  highlighted,
  onChange,
  t,
}: {
  book: UserBook
  language: string
  highlighted: boolean
  onChange: () => void
  t: (key: string) => string
}) {
  // Ready = the file's bytes are in: the reader parses the file itself (ADR-033).
  const readable = book.status === 'Ready'
  const percent = book.progressPercent ?? 0
  // The row opens the book's page; "Continue" goes straight into the text.
  const destination = readable ? `/${language}/library/my/${book.id}` : '#'
  // A PDF's position is a page, not a chapter — its Original reader resumes it from /read.
  const continueHref = book.progressChapterSlug
    ? `/${language}/library/my/${book.id}/read/${book.progressChapterSlug}`
    : book.hasOriginalPdf && percent > 0
      ? `/${language}/library/my/${book.id}/read`
      : null
  const showContinue = readable && !!continueHref && !book.completedAt
  const coverUrl = platform.library.getUserBookCoverUrl(book.coverPath)
  const [coverHidden, onCoverError, coverSrc] = useCoverRetry(coverUrl)
  return (
    <article data-book-id={book.id} className={`library-list-item${highlighted ? ' library-list-item--highlighted' : ''}`}>
      {readable ? (
        <Link to={destination} className="library-list-item__cover">
          {!coverHidden ? (
            <img
              src={coverSrc}
              alt={book.title}
              onError={onCoverError}
            />
          ) : null}
          <div
            className={`library-list-item__cover-placeholder ${coverHidden ? '' : 'hidden'}`}
            style={{ backgroundColor: stringToColor(book.title) }}
          >
            {book.title?.[0] || '?'}
          </div>
        </Link>
      ) : (
        <div className="library-list-item__cover library-list-item__cover--disabled">
          {!coverHidden ? (
            <img
              src={coverSrc}
              alt={book.title}
              onError={onCoverError}
            />
          ) : null}
          <div
            className={`library-list-item__cover-placeholder ${coverHidden ? '' : 'hidden'}`}
            style={{ backgroundColor: stringToColor(book.title) }}
          >
            {book.title?.[0] || '?'}
          </div>
        </div>
      )}
      <div className="library-list-item__content">
        {readable ? (
          <Link to={destination} className="library-list-item__title">
            {book.title}
          </Link>
        ) : (
          <span className="library-list-item__title">{book.title}</span>
        )}
        {readable && book.completedAt && (
          <div className="library-list-item__progress">
            <div className="library-list-item__progress-header">
              <span className="library-list-item__completed-text">Read</span>
            </div>
          </div>
        )}
        {readable && !book.completedAt && (
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
        )}
        <div className="library-list-item__info">
          {book.chapterCount > 0 && (
            <span className="library-list-item__info-item">
              {book.chapterCount} {t('library.chapters')}
            </span>
          )}
          {readable && book.progressUpdatedAt && (
            <span className="library-list-item__info-item">
              <span className="material-icons-outlined">schedule</span>
              {t('library.lastRead')} {formatTimeAgo(book.progressUpdatedAt)}
            </span>
          )}
          {!readable && (
            <span className="library-list-item__info-item library-list-item__info-item--error">
              <span className="material-icons-outlined">error</span>
              {t('library.failed')}
            </span>
          )}
        </div>
      </div>
      <div className="library-list-item__actions">
        {showContinue && (
          <Link to={continueHref!} className="library-continue">{t('library.continue')}</Link>
        )}
        <BookActionMenu book={book} onChange={onChange} />
      </div>
    </article>
  )
}
