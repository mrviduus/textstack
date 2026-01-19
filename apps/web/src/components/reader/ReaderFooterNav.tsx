import type { ChapterNav } from '../../types/api'

interface Props {
  bookSlug: string
  chapterTitle: string
  prev: ChapterNav | null
  next: ChapterNav | null
  progress: number
  pagesLeft: number
  currentPage: number
  totalPages: number
  scrollPercent: number
  overallProgress: number
}

export function ReaderFooterNav({
  chapterTitle,
  overallProgress,
}: Props) {
  const bookPercent = Math.round(overallProgress * 100)

  return (
    <footer className="reader-footer">
      {/* Desktop: book-based progress */}
      <div className="reader-footer__progress reader-footer__progress--desktop">
        <div
          className="reader-footer__progress-bar"
          style={{ width: `${bookPercent}%` }}
          role="progressbar"
          aria-valuenow={bookPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Reading progress"
        />
      </div>

      {/* Mobile: book-based progress (same as desktop for consistency) */}
      <div className="reader-footer__progress reader-footer__progress--mobile">
        <div
          className="reader-footer__progress-bar"
          style={{ width: `${bookPercent}%` }}
          role="progressbar"
          aria-valuenow={bookPercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Reading progress"
        />
      </div>

      <div className="reader-footer__info">
        <span className="reader-footer__chapter">{chapterTitle}</span>
        {/* Desktop: overall book progress */}
        <span className="reader-footer__pages reader-footer__pages--desktop">
          {bookPercent}%
        </span>
        {/* Mobile: overall book progress */}
        <span className="reader-footer__pages reader-footer__pages--mobile">
          {bookPercent}%
        </span>
      </div>
    </footer>
  )
}
