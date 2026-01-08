import { LocalizedLink } from '../LocalizedLink'
import type { ChapterSummary } from '../../types/api'
import { useFocusTrap } from '../../hooks/useFocusTrap'

interface Props {
  open: boolean
  bookSlug: string
  chapters: ChapterSummary[]
  currentChapterSlug: string
  onClose: () => void
}

export function ReaderTocDrawer({ open, bookSlug, chapters, currentChapterSlug, onClose }: Props) {
  const containerRef = useFocusTrap(open)

  if (!open) return null

  return (
    <>
      <div className="reader-drawer-backdrop" onClick={onClose} />
      <div className="reader-toc-drawer" ref={containerRef} role="dialog" aria-modal="true" aria-label="Table of Contents">
        <div className="reader-toc-drawer__header">
          <h3>Table of Contents</h3>
          <button onClick={onClose} className="reader-toc-drawer__close">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <ul className="reader-toc-drawer__list">
          {chapters.map((ch) => (
            <li key={ch.id}>
              <LocalizedLink
                to={`/books/${bookSlug}/${ch.slug}`}
                className={`reader-toc-drawer__item ${ch.slug === currentChapterSlug ? 'active' : ''}`}
                onClick={onClose}
              >
                <span className="reader-toc-drawer__number">{ch.chapterNumber + 1}</span>
                <span className="reader-toc-drawer__title">{ch.title}</span>
              </LocalizedLink>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
