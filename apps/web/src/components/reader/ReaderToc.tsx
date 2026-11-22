import { useEffect, useState } from 'react'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useTranslation } from '../../hooks/useTranslation'
import { tocAround, type TocEntry } from '../../../../../packages/reader/src/toc.mjs'
import type { HighlightItem } from '../../../../../packages/reader/src/highlights.mjs'
import type { BookmarkItem } from '../../../../../packages/reader/src/bookmarks.mjs'
import { COLOR_MAP } from './decorationColors'

/** `toc` through `readToc`, `tocIndex` through `readRelocate` (toc.mjs: the book is untrusted); `onGo`: the entry the reader chose. */
interface Props {
  toc: TocEntry[]
  tocIndex: number | null
  onGo: (entry: TocEntry) => void
}

/** #1312: the Highlights tab (absent where the host offers no highlights: an image or PDF book, the server's not in yet). */
interface HighlightsTab {
  /** The page's `highlight-list` (in book order, drawn ones only). */
  items: HighlightItem[]
  /** The host's note of one (the page holds none). */
  noteOf: (id: string) => string | null
  onGo: (item: HighlightItem) => void
}

/** #1314: the Bookmarks tab, offered with the Highlights tab. */
interface BookmarksTab {
  /** The page's `bookmark-list` items (in book order). */
  items: BookmarkItem[]
  /** One can be made at the place on screen (the page's `can`): the empty list says how, or that this page takes none. */
  can: boolean
  /** Bookmarks are still being placed (or the page has not said yet): the empty list says they are loading. */
  placing: boolean
  onGo: (item: BookmarkItem) => void
  /** The row's remove button: the page removes it and the host tombstones it, wherever in the book it is. */
  onRemove: (id: string) => void
}

/**
 * The V2 reader's table of contents (#1261): the legacy drawer's dialog (reader.css, `useFocusTrap`), the entries
 * indented by depth, the current one marked and focused on open (which scrolls it into view). Closing gives focus back.
 * With `highlights` (#1312) a Highlights tab beside Contents, the legacy drawer's (a book with no contents opens on
 * it): each highlight's text and note as text, in book order; a tap jumps there. With `bookmarks` (#1314) a Bookmarks
 * tab too: each bookmark's first words as text, in book order; a tap jumps there.
 */
export function TocDrawer({ open, toc, tocIndex, onGo, onClose, highlights, bookmarks }: Props & { open: boolean; onClose: () => void; highlights?: HighlightsTab | null; bookmarks?: BookmarksTab | null }) {
  const container = useFocusTrap(open)
  const { t } = useTranslation()
  const [chosenTab, setTab] = useState<'contents' | 'highlights' | 'bookmarks'>('contents')
  // The tab chosen while it is offered; else Contents when the book has any, else the first list offered.
  const offered = { contents: toc.length > 0, highlights: !!highlights, bookmarks: !!bookmarks }
  const tab = offered[chosenTab] ? chosenTab : offered.contents || (!highlights && !bookmarks) ? 'contents' : highlights ? 'highlights' : 'bookmarks'
  // After the trap's own focus (the close button).
  useEffect(() => {
    if (open) container.current?.querySelector<HTMLElement>('[aria-current]')?.focus()
  }, [open])
  if (!open) return null
  const { current } = tocAround(toc, tocIndex)
  return (
    <>
      <div className="reader-drawer-backdrop" onClick={onClose} />
      <div
        className="reader-toc-drawer"
        ref={container}
        role="dialog"
        aria-modal="true"
        aria-label={t('v2Reader.contents')}
        // The reader's own keys (arrows, Space, Esc: the bars) stay out of the dialog; Tab goes on to the focus trap.
        onKeyDown={(e) => {
          if (e.key !== 'Tab') e.stopPropagation()
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="reader-toc-drawer__header">
          {highlights || bookmarks ? (
            <div className="reader-toc-drawer__tabs" role="tablist">
              {toc.length > 0 && (
                <button role="tab" aria-selected={tab === 'contents'} className={`reader-toc-drawer__tab${tab === 'contents' ? ' active' : ''}`} onClick={() => setTab('contents')}>
                  {t('v2Reader.contents')}
                </button>
              )}
              {highlights && (
                <button role="tab" aria-selected={tab === 'highlights'} className={`reader-toc-drawer__tab${tab === 'highlights' ? ' active' : ''}`} onClick={() => setTab('highlights')} data-testid="v2-highlights-tab">
                  {t('reader.toc.highlightsTab')} {highlights.items.length > 0 && `(${highlights.items.length})`}
                </button>
              )}
              {bookmarks && (
                <button role="tab" aria-selected={tab === 'bookmarks'} className={`reader-toc-drawer__tab${tab === 'bookmarks' ? ' active' : ''}`} onClick={() => setTab('bookmarks')} data-testid="v2-bookmarks-tab">
                  {t('reader.chrome.bookmarks')} {bookmarks.items.length > 0 && `(${bookmarks.items.length})`}
                </button>
              )}
            </div>
          ) : (
            <h3>{t('v2Reader.contents')}</h3>
          )}
          <button onClick={onClose} className="reader-toc-drawer__close" aria-label={t('v2Reader.closeContents')}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {tab === 'highlights' && highlights && (
          <ul className="reader-toc-drawer__list" data-testid="v2-highlights-list">
            {highlights.items.map((h) => {
              const note = highlights.noteOf(h.id)
              return (
                <li key={h.id} className="reader-toc-drawer__bookmark-item">
                  {/* #1195: a quotation (the earlier reader's highlight) is listed, never drawn: nowhere to go. */}
                  <button type="button" className="reader-toc-drawer__item reader-toc-drawer__hl-item" disabled={h.quotation} onClick={() => { highlights.onGo(h); onClose() }}>
                    <span className="reader-toc-drawer__hl-swatch" style={{ backgroundColor: COLOR_MAP[h.color] }} aria-hidden="true" />
                    {/* The book's text and the reader's note: React text only (untrusted). */}
                    <span className="reader-toc-drawer__hl-body">
                      <span className="reader-toc-drawer__hl-text">{h.text}</span>
                      {note && <span className="reader-toc-drawer__hl-note">{note}</span>}
                    </span>
                  </button>
                </li>
              )
            })}
            {highlights.items.length === 0 && <li className="reader-toc-drawer__empty">{t('reader.toc.highlightsEmpty')}</li>}
          </ul>
        )}
        {tab === 'bookmarks' && bookmarks && (
          <ul className="reader-toc-drawer__list" data-testid="v2-bookmarks-list">
            {bookmarks.items.map((b) => (
              <li key={b.id} className="reader-toc-drawer__bookmark-item">
                <button type="button" className="reader-toc-drawer__item reader-toc-drawer__hl-item" data-testid="v2-bookmark-row" onClick={() => { bookmarks.onGo(b); onClose() }}>
                  {/* The book's text: React text only (untrusted). */}
                  <span className="reader-toc-drawer__hl-body">
                    <span className="reader-toc-drawer__hl-text">{b.text}</span>
                  </span>
                </button>
                {/* Named by the bookmark's words: a screen reader tells the rows' buttons apart. */}
                <button type="button" className="reader-toc-drawer__remove" data-testid="v2-bookmark-remove" aria-label={`${t('reader.chrome.removeBookmark')}: ${b.text}`} title={t('reader.chrome.removeBookmark')} onClick={() => bookmarks.onRemove(b.id)}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </li>
            ))}
            {bookmarks.items.length === 0 && (
              <li className="reader-toc-drawer__empty">{t(bookmarks.placing ? 'reader.chrome.bookmarksLoading' : bookmarks.can ? 'reader.chrome.bookmarksEmpty' : 'reader.chrome.bookmarksNotHere')}</li>
            )}
          </ul>
        )}
        {tab === 'contents' && <ul className="reader-toc-drawer__list">
          {toc.map((e) => (
            <li key={e.index}>
              <button
                type="button"
                className={`reader-toc-drawer__item reader-toc-drawer__hl-item${e === current ? ' active' : ''}`}
                aria-current={e === current ? 'true' : undefined}
                data-depth={e.depth}
                style={{ paddingLeft: 16 + e.depth * 16 }}
                onClick={() => {
                  onGo(e)
                  onClose()
                }}
              >
                <span className="reader-toc-drawer__title">{e.label}</span>
              </button>
            </li>
          ))}
        </ul>}
      </div>
    </>
  )
}

/** The entries before and after the reader's place, by title (#1261): never a number. None on a book with no contents. */
export function SectionNav({ toc, tocIndex, onGo }: Props) {
  const { t } = useTranslation()
  const { prev, next } = tocAround(toc, tocIndex)
  if (!prev && !next) return null
  return (
    <div className="v2-reader__sections">
      {prev && (
        <button className="reader-top-bar__btn" data-testid="v2-prev-section" aria-label={t('v2Reader.prevSection', { title: prev.label })} onClick={() => onGo(prev)}>
          ‹ {prev.label}
        </button>
      )}
      {next && (
        <button className="reader-top-bar__btn v2-reader__section-next" data-testid="v2-next-section" aria-label={t('v2Reader.nextSection', { title: next.label })} onClick={() => onGo(next)}>
          {next.label} ›
        </button>
      )}
    </div>
  )
}
