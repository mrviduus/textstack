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
}

export function ReaderFooterNav({
  chapterTitle,
  progress,
  pagesLeft,
  currentPage,
  totalPages,
}: Props) {
  const percent = Math.round(progress * 100)

  return (
    <footer className="reader-footer">
      <div className="reader-footer__progress">
        <div
          className="reader-footer__progress-bar"
          style={{ width: `${percent}%` }}
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Reading progress"
        />
      </div>

      <div className="reader-footer__info">
        <span className="reader-footer__chapter">{chapterTitle}</span>
        <span className="reader-footer__pages">
          {pagesLeft === 0
            ? 'Last page'
            : `${pagesLeft} page${pagesLeft === 1 ? '' : 's'} left`}
          {' · '}
          {percent}%
        </span>
      </div>
    </footer>
  )
}
