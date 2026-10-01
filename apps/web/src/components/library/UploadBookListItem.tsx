// Uploaded (user) book row in the library list view. Extracted verbatim from
// LibraryPage.tsx (R6 slice-1) — presentational; `key` stays at the call site.
import { Link } from 'react-router-dom'
import { getUserBookCoverUrl, type UserBook } from '../../api/userBooks'
import { BookActionMenu } from './BookActionMenu'
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
  const isReady = book.status === 'Ready'
  // Readability is DERIVED (ADR-012): a PDF opens in Original layout once its file exists, whatever
  // the extraction status — same rule as the grid card (UserBookCard).
  const readable = isReady || !!book.hasOriginalPdf
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
  const coverUrl = getUserBookCoverUrl(book.coverPath)
  return (
    <article data-book-id={book.id} className={`library-list-item${highlighted ? ' library-list-item--highlighted' : ''}`}>
      {readable ? (
        <Link to={destination} className="library-list-item__cover">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={book.title}
              onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextElementSibling?.classList.remove('hidden') }}
            />
          ) : null}
          <div
            className={`library-list-item__cover-placeholder ${coverUrl ? 'hidden' : ''}`}
            style={{ backgroundColor: stringToColor(book.title) }}
          >
            {book.title?.[0] || '?'}
          </div>
        </Link>
      ) : (
        <div className="library-list-item__cover library-list-item__cover--disabled">
          {coverUrl ? (
            <img
              src={coverUrl}
              alt={book.title}
              onError={(e) => { e.currentTarget.style.display = 'none'; e.currentTarget.nextElementSibling?.classList.remove('hidden') }}
            />
          ) : null}
          <div
            className={`library-list-item__cover-placeholder ${coverUrl ? 'hidden' : ''}`}
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
          {book.status === 'Processing' && (
            <span className="library-list-item__info-item library-list-item__info-item--processing">
              <span className="material-icons-outlined">sync</span>
              {t('library.processing')}
            </span>
          )}
          {book.status === 'Failed' && (
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
        <BookActionMenu type="userbook" book={book} onChange={onChange} />
      </div>
    </article>
  )
}
