import { useState } from 'react'
import { Link } from 'react-router-dom'
import { isPdfAnchor } from '@textstack/shared'
import { LocalizedLink } from '../LocalizedLink'
import type { Bookmark } from '../../hooks/useBookmarks'
import type { StoredHighlight } from '../../lib/offlineDb'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useTranslation } from '../../hooks/useTranslation'
import { HighlightQuote } from '../HighlightQuote'
import { COLOR_MAP } from './decorationColors'


/** Sort by reading position: reflow → text offset; PDF → page then rect y;
 *  mixed/unknown → newest first. A book is normally all-reflow or all-PDF. */
export function sortHighlightsByPosition(highlights: StoredHighlight[]): StoredHighlight[] {
  return [...highlights].sort((a, b) => {
    const aa = a.anchor
    const ba = b.anchor
    if (isPdfAnchor(aa) && isPdfAnchor(ba)) {
      if (aa.page !== ba.page) return aa.page - ba.page
      const ay = aa.rects.length ? Math.min(...aa.rects.map((r) => r.y)) : 0
      const by = ba.rects.length ? Math.min(...ba.rects.map((r) => r.y)) : 0
      return ay - by
    }
    if (!isPdfAnchor(aa) && !isPdfAnchor(ba)) {
      return aa.startOffset - ba.startOffset
    }
    return b.createdAt - a.createdAt
  })
}

export interface AutoSaveInfo {
  chapterSlug: string
  chapterTitle: string
  locator: string
  percent: number
}

// Normalized chapter for both public and user books
export interface TocChapter {
  id: string
  identifier: string // slug for public, chapterNumber as string for user
  title: string
  chapterNumber: number
  wordCount?: number | null
  /** 1-based PDF page where the chapter starts (Original-layout scroll target). */
  sourceStartPage?: number | null
}

interface Props {
  open: boolean
  chapters: TocChapter[]
  currentChapterIdentifier: string
  bookmarks: Bookmark[]
  highlights?: StoredHighlight[]
  autoSave?: AutoSaveInfo | null
  getChapterUrl: (identifier: string) => string
  useLocalizedLink?: boolean // true for public, false for user books
  onClose: () => void
  onRemoveBookmark: (id: string) => void
  onChapterSelect?: (identifier: string) => void // For scroll mode: scroll to chapter instead of navigate
  onBookmarkSelect?: (bookmark: Bookmark) => void // Original-layout PDF: jump to the bookmark's page instead of navigating
  onHighlightSelect?: (highlight: StoredHighlight) => void // Highlights tab: jump to the highlight (navigation-only)
}

type Tab = 'contents' | 'bookmarks' | 'highlights'

export function ReaderTocDrawer({
  open,
  chapters,
  currentChapterIdentifier,
  bookmarks,
  highlights = [],
  autoSave,
  getChapterUrl,
  useLocalizedLink = true,
  onClose,
  onRemoveBookmark,
  onChapterSelect,
  onBookmarkSelect,
  onHighlightSelect,
}: Props) {
  const containerRef = useFocusTrap(open)
  const { t } = useTranslation()
  const [activeTab, setActiveTab] = useState<Tab>('contents')

  if (!open) return null

  const ChapterLink = useLocalizedLink ? LocalizedLink : Link
  const sortedHighlights = sortHighlightsByPosition(highlights)

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    })
  }

  return (
    <>
      <div className="reader-drawer-backdrop" onClick={onClose} />
      <div className="reader-toc-drawer" ref={containerRef} role="dialog" aria-modal="true" aria-label="Table of Contents">
        <div className="reader-toc-drawer__header">
          <div className="reader-toc-drawer__tabs">
            <button
              className={`reader-toc-drawer__tab ${activeTab === 'contents' ? 'active' : ''}`}
              onClick={() => setActiveTab('contents')}
            >
              Contents
            </button>
            <button
              className={`reader-toc-drawer__tab ${activeTab === 'bookmarks' ? 'active' : ''}`}
              onClick={() => setActiveTab('bookmarks')}
            >
              Bookmarks {bookmarks.length > 0 && `(${bookmarks.length})`}
            </button>
            <button
              className={`reader-toc-drawer__tab ${activeTab === 'highlights' ? 'active' : ''}`}
              onClick={() => setActiveTab('highlights')}
            >
              {t('reader.toc.highlightsTab')} {highlights.length > 0 && `(${highlights.length})`}
            </button>
          </div>
          <button onClick={onClose} className="reader-toc-drawer__close">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {activeTab === 'contents' && (
          <ul className="reader-toc-drawer__list">
            {chapters.map((ch) => (
              <li key={ch.id}>
                <ChapterLink
                  to={`${getChapterUrl(ch.identifier)}?direct=1`}
                  className={`reader-toc-drawer__item ${ch.identifier === currentChapterIdentifier ? 'active' : ''}`}
                  onClick={(e) => {
                    if (onChapterSelect) {
                      e.preventDefault()
                      onChapterSelect(ch.identifier)
                    }
                    onClose()
                  }}
                >
                  <span className="reader-toc-drawer__number">{ch.chapterNumber + 1}</span>
                  <span className="reader-toc-drawer__title">{ch.title}</span>
                </ChapterLink>
              </li>
            ))}
          </ul>
        )}

        {activeTab === 'bookmarks' && (
          <ul className="reader-toc-drawer__list">
            {/* Auto-saved position first */}
            {autoSave && (
              <li className="reader-toc-drawer__bookmark-item reader-toc-drawer__autosave">
                <ChapterLink
                  to={getChapterUrl(autoSave.chapterSlug)}
                  className={`reader-toc-drawer__item ${autoSave.chapterSlug === currentChapterIdentifier ? 'active' : ''}`}
                  onClick={onClose}
                >
                  <span className="reader-toc-drawer__title">{autoSave.chapterTitle}</span>
                  <span className="reader-toc-drawer__date">Auto-saved</span>
                </ChapterLink>
              </li>
            )}
            {/* Manual bookmarks */}
            {bookmarks.map((bm) => (
              <li key={bm.id} className="reader-toc-drawer__bookmark-item">
                <ChapterLink
                  to={bm.page != null ? '#' : getChapterUrl(bm.chapterSlug)}
                  className={`reader-toc-drawer__item ${bm.chapterSlug === currentChapterIdentifier ? 'active' : ''}`}
                  onClick={(e) => {
                    // Original-layout page bookmark: jump the PDF to its page
                    // instead of routing to a (nonexistent) chapter URL.
                    if (onBookmarkSelect && bm.page != null) {
                      e.preventDefault()
                      onBookmarkSelect(bm)
                    }
                    onClose()
                  }}
                >
                  <span className="reader-toc-drawer__title">
                    {bm.page != null ? `Page ${bm.page}` : bm.chapterTitle}
                  </span>
                  <span className="reader-toc-drawer__date">{formatDate(bm.createdAt)}</span>
                </ChapterLink>
                <button
                  className="reader-toc-drawer__remove"
                  onClick={(e) => {
                    e.stopPropagation()
                    onRemoveBookmark(bm.id)
                  }}
                  title="Remove bookmark"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </li>
            ))}
            {/* Empty state only if no autosave AND no bookmarks */}
            {!autoSave && bookmarks.length === 0 && (
              <li className="reader-toc-drawer__empty">
                No bookmarks yet. Tap the bookmark icon while reading to save your place.
              </li>
            )}
          </ul>
        )}

        {activeTab === 'highlights' && (
          <ul className="reader-toc-drawer__list">
            {sortedHighlights.map((h) => (
              <li key={h.id} className="reader-toc-drawer__bookmark-item">
                <button
                  type="button"
                  className="reader-toc-drawer__item reader-toc-drawer__hl-item"
                  onClick={() => {
                    onHighlightSelect?.(h)
                    onClose()
                  }}
                >
                  <span
                    className="reader-toc-drawer__hl-swatch"
                    style={{ backgroundColor: COLOR_MAP[h.color] }}
                    aria-hidden="true"
                  />
                  <span className="reader-toc-drawer__hl-body">
                    <span className="reader-toc-drawer__hl-text">
                      <HighlightQuote anchor={h.anchor} selectedText={h.selectedText || h.anchor.exact} />
                    </span>
                    {h.noteText && (
                      <span className="reader-toc-drawer__hl-note">{h.noteText}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
            {highlights.length === 0 && (
              <li className="reader-toc-drawer__empty">
                {t('reader.toc.highlightsEmpty')}
              </li>
            )}
          </ul>
        )}
      </div>
    </>
  )
}
