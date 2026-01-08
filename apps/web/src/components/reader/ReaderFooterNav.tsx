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
}

export function ReaderFooterNav({
  chapterTitle,
  progress,
  pagesLeft,
  scrollPercent,
}: Props) {
  const pagePercent = Math.round(progress * 100)
  const scrollPct = Math.round(scrollPercent * 100)

  return (
    <footer className="reader-footer">
      {/* Desktop: page-based progress */}
      <div className="reader-footer__progress reader-footer__progress--desktop">
        <div
          className="reader-footer__progress-bar"
          style={{ width: `${pagePercent}%` }}
          role="progressbar"
          aria-valuenow={pagePercent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Reading progress"
        />
      </div>

      {/* Mobile: scroll-based progress */}
      <div className="reader-footer__progress reader-footer__progress--mobile">
        <div
          className="reader-footer__progress-bar"
          style={{ width: `${scrollPct}%` }}
          role="progressbar"
          aria-valuenow={scrollPct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Reading progress"
        />
      </div>

      <div className="reader-footer__info">
        <span className="reader-footer__chapter">{chapterTitle}</span>
        {/* Desktop: pages left */}
        <span className="reader-footer__pages reader-footer__pages--desktop">
          {pagesLeft === 0
            ? 'Last page'
            : `${pagesLeft} page${pagesLeft === 1 ? '' : 's'} left`}
          {' · '}
          {pagePercent}%
        </span>
        {/* Mobile: scroll percent */}
        <span className="reader-footer__pages reader-footer__pages--mobile">
          {scrollPct}%
        </span>
      </div>
    </footer>
  )
}
