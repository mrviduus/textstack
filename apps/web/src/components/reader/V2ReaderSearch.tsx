import { useEffect, useRef, useState } from 'react'
import { useDebounce } from '../../hooks/useDebounce'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { useTranslation } from '../../hooks/useTranslation'
import { MAX_QUERY, readQuery, type V2Search, type V2SearchResult } from '../../../../mobile/src/lib/v2reader/search.mjs'

/** The reader stopped typing for this long: the page is asked (a new search ends the one running). */
export const SEARCH_DEBOUNCE_MS = 300

interface Props {
  open: boolean
  /** The host's search (search.mjs): the query the page was asked, its results so far. */
  search: V2Search
  /** What the reader typed, debounced; '' clears the search and the hits drawn in the book. */
  onQuery: (raw: string) => void
  /** A result the reader chose. */
  onGo: (result: V2SearchResult) => void
  onClose: () => void
}

/**
 * The V2 reader's in-book search (#1315): the legacy search drawer's dialog (reader.css, `useFocusTrap`). The page
 * searches the whole book and streams its hits (`search-results`, read by the host through `readSearchResults`); each
 * is listed with the text around it and its section's title, React text only (the book is untrusted). A tap jumps
 * there; closing keeps the search, so the drawer opens again on the same results. The host keys it by the open: a new
 * book's drawer starts empty.
 */
export function V2SearchDrawer({ open, search, onQuery, onGo, onClose }: Props) {
  const container = useFocusTrap(open)
  const { t } = useTranslation()
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(search.query)
  const typed = useDebounce(text, SEARCH_DEBOUNCE_MS)
  const onQueryRef = useRef(onQuery)
  onQueryRef.current = onQuery
  // Asked only when what was typed is another query than the one the page has (reopening the drawer asks nothing).
  useEffect(() => {
    if ((readQuery(typed) ?? '') !== search.query) onQueryRef.current(typed)
  }, [typed])
  if (!open) return null
  const count = search.results.length
  const status = !search.query ? ''
    : !search.done ? t('v2Reader.searching')
      : count === 0 ? t('v2Reader.searchNone')
        : search.more ? t('v2Reader.searchMore', { count }) : t('v2Reader.searchCount', { count })
  return (
    <>
      <div className="reader-drawer-backdrop" onClick={onClose} />
      <div
        className="reader-search-drawer"
        ref={container}
        role="dialog"
        aria-modal="true"
        aria-label={t('v2Reader.searchLabel')}
        // The reader's own keys (arrows, Space, Esc: the bars) stay out of the dialog; Tab goes on to the focus trap.
        onKeyDown={(e) => {
          if (e.key !== 'Tab') e.stopPropagation()
          if (e.key === 'Escape') onClose()
        }}
      >
        <div className="reader-search-drawer__header">
          {/* The field is the dialog's first control: the focus trap puts focus on it at opening. */}
          <div className="reader-search-drawer__input-wrapper">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              ref={input}
              type="search"
              className="reader-search-drawer__input"
              aria-label={t('v2Reader.searchLabel')}
              placeholder={t('v2Reader.searchPlaceholder')}
              maxLength={MAX_QUERY}
              value={text}
              onChange={(e) => setText(e.target.value)}
              data-testid="v2-search-input"
            />
            {text && (
              <button onClick={() => { setText(''); input.current?.focus() }} className="reader-search-drawer__clear" aria-label={t('v2Reader.searchClear')}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          <button onClick={onClose} className="reader-search-drawer__close" aria-label={t('v2Reader.searchClose')}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        {/* Always mounted: a live region announces a change of its text, not its own arrival. */}
        <div className="reader-search-drawer__nav">
          <span className="reader-search-drawer__count" role="status" data-testid="v2-search-status">{status}</span>
        </div>
        <ul className="reader-search-drawer__results" data-testid="v2-search-results">
          {search.results.map((r) => (
            <li key={r.cfi}>
              <button type="button" className="reader-search-drawer__result" onClick={() => { onGo(r); onClose() }}>
                {/* The book's text: React text only (untrusted). */}
                {r.label && <span className="reader-search-drawer__section">{r.label}</span>}
                <span className="reader-search-drawer__context">{r.pre}<mark>{r.match}</mark>{r.post}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
