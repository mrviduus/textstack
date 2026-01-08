import { useEffect, useRef } from 'react'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import type { SearchMatch } from '../../hooks/useInBookSearch'

interface Props {
  open: boolean
  query: string
  matches: SearchMatch[]
  activeMatchIndex: number
  onSearch: (query: string) => void
  onGoToMatch: (index: number) => void
  onNextMatch: () => void
  onPrevMatch: () => void
  onClose: () => void
}

export function ReaderSearchDrawer({
  open,
  query,
  matches,
  activeMatchIndex,
  onSearch,
  onGoToMatch,
  onNextMatch,
  onPrevMatch,
  onClose,
}: Props) {
  const containerRef = useFocusTrap(open)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input when drawer opens
  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
    }
  }, [open])

  if (!open) return null

  const highlightMatch = (context: string, queryText: string) => {
    if (!queryText) return context
    const lowerContext = context.toLowerCase()
    const lowerQuery = queryText.toLowerCase()
    const index = lowerContext.indexOf(lowerQuery)
    if (index === -1) return context

    return (
      <>
        {context.slice(0, index)}
        <mark>{context.slice(index, index + queryText.length)}</mark>
        {context.slice(index + queryText.length)}
      </>
    )
  }

  return (
    <>
      <div className="reader-drawer-backdrop" onClick={onClose} />
      <div className="reader-search-drawer" ref={containerRef} role="dialog" aria-modal="true" aria-label="Search in chapter">
        <div className="reader-search-drawer__header">
          <div className="reader-search-drawer__input-wrapper">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              placeholder="Search in chapter..."
              value={query}
              onChange={(e) => onSearch(e.target.value)}
              className="reader-search-drawer__input"
            />
            {query && (
              <button onClick={() => onSearch('')} className="reader-search-drawer__clear" title="Clear">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          <button onClick={onClose} className="reader-search-drawer__close">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {query && query.length >= 2 && (
          <div className="reader-search-drawer__nav">
            <span className="reader-search-drawer__count">
              {matches.length === 0
                ? 'No results'
                : `${activeMatchIndex + 1} of ${matches.length}`}
            </span>
            <div className="reader-search-drawer__nav-buttons">
              <button onClick={onPrevMatch} disabled={matches.length === 0} title="Previous">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 15l-6-6-6 6" />
                </svg>
              </button>
              <button onClick={onNextMatch} disabled={matches.length === 0} title="Next">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            </div>
          </div>
        )}

        <ul className="reader-search-drawer__results">
          {matches.map((match) => (
            <li key={match.index}>
              <button
                className={`reader-search-drawer__result ${match.index === activeMatchIndex ? 'active' : ''}`}
                onClick={() => onGoToMatch(match.index)}
              >
                <span className="reader-search-drawer__context">
                  {highlightMatch(match.context, query)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </>
  )
}
