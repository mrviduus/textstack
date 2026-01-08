import { LocalizedLink } from '../LocalizedLink'
import type { ChapterNav } from '../../types/api'

interface Props {
  bookSlug: string
  prev: ChapterNav | null
  next: ChapterNav | null
  currentChapter: number
  totalChapters: number
  scrollPercent: number
}

export function ReaderFooterNav({ bookSlug, prev, next, currentChapter, totalChapters, scrollPercent }: Props) {
  // scrollPercent shows reading position within current chapter (0-1)

  return (
    <footer className="reader-footer">
      {/* Scroll progress bar (reading position in chapter) */}
      <div className="reader-footer__progress">
        <div
          className="reader-footer__progress-bar"
          style={{ width: `${scrollPercent * 100}%` }}
          role="progressbar"
          aria-valuenow={Math.round(scrollPercent * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Reading progress"
        />
      </div>

      <div className="reader-footer__nav">
        {prev ? (
          <LocalizedLink to={`/books/${bookSlug}/${prev.slug}`} className="reader-footer__link reader-footer__link--prev">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            <span>{prev.title}</span>
          </LocalizedLink>
        ) : (
          <div />
        )}

        {/* Chapter indicator */}
        <div className="reader-footer__chapter-info">
          <span className="reader-footer__chapter-current">{currentChapter}</span>
          <span className="reader-footer__chapter-separator">/</span>
          <span className="reader-footer__chapter-total">{totalChapters}</span>
        </div>

        {next ? (
          <LocalizedLink to={`/books/${bookSlug}/${next.slug}`} className="reader-footer__link reader-footer__link--next">
            <span>{next.title}</span>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M9 18l6-6-6-6" />
            </svg>
          </LocalizedLink>
        ) : (
          <div />
        )}
      </div>
    </footer>
  )
}
