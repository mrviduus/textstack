import { useState } from 'react'
import { LocalizedLink } from '../LocalizedLink'
import type { ChapterSummary } from '../../types/api'
import type { Bookmark } from '../../hooks/useBookmarks'
import { useFocusTrap } from '../../hooks/useFocusTrap'

export interface AutoSaveInfo {
  chapterSlug: string
  chapterTitle: string
  locator: string
  percent: number
}

interface Props {
  open: boolean
  bookSlug: string
  chapters: ChapterSummary[]
  currentChapterSlug: string
  bookmarks: Bookmark[]
  autoSave?: AutoSaveInfo | null
  onClose: () => void
  onRemoveBookmark: (id: string) => void
  onChapterSelect?: (slug: string) => void // For scroll mode: scroll to chapter instead of navigate
}

type Tab = 'contents' | 'bookmarks'

export function ReaderTocDrawer({
  open,
  bookSlug,
  chapters,
  currentChapterSlug,
  bookmarks,
  autoSave,
  onClose,
  onRemoveBookmark,
  onChapterSelect,
}: Props) {
  const containerRef = useFocusTrap(open)
  const [activeTab, setActiveTab] = useState<Tab>('contents')

  if (!open) return null

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
                <LocalizedLink
                  to={`/books/${bookSlug}/${ch.slug}?direct=1`}
                  className={`reader-toc-drawer__item ${ch.slug === currentChapterSlug ? 'active' : ''}`}
                  onClick={(e) => {
                    if (onChapterSelect) {
                      e.preventDefault()
                      onChapterSelect(ch.slug)
                    }
                    onClose()
                  }}
                >
                  <span className="reader-toc-drawer__number">{ch.chapterNumber + 1}</span>
                  <span className="reader-toc-drawer__title">{ch.title}</span>
                </LocalizedLink>
              </li>
            ))}
          </ul>
        )}

        {activeTab === 'bookmarks' && (
          <ul className="reader-toc-drawer__list">
            {/* Auto-saved position first */}
            {autoSave && (
              <li className="reader-toc-drawer__bookmark-item reader-toc-drawer__autosave">
                <LocalizedLink
                  to={`/books/${bookSlug}/${autoSave.chapterSlug}`}
                  className={`reader-toc-drawer__item ${autoSave.chapterSlug === currentChapterSlug ? 'active' : ''}`}
                  onClick={onClose}
                >
                  <span className="reader-toc-drawer__title">{autoSave.chapterTitle}</span>
                  <span className="reader-toc-drawer__date">Auto-saved</span>
                </LocalizedLink>
              </li>
            )}
            {/* Manual bookmarks */}
            {bookmarks.map((bm) => (
              <li key={bm.id} className="reader-toc-drawer__bookmark-item">
                <LocalizedLink
                  to={`/books/${bookSlug}/${bm.chapterSlug}`}
                  className={`reader-toc-drawer__item ${bm.chapterSlug === currentChapterSlug ? 'active' : ''}`}
                  onClick={onClose}
                >
                  <span className="reader-toc-drawer__title">{bm.chapterTitle}</span>
                  <span className="reader-toc-drawer__date">{formatDate(bm.createdAt)}</span>
                </LocalizedLink>
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
      </div>
    </>
  )
}
