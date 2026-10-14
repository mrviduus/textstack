import { useState, useCallback, useEffect } from 'react'
import { mountedEngineFor } from '../lib/readerEngine'
import type { Locator } from '@textstack/reader-engine'

export interface SearchMatch {
  index: number
  text: string
  context: string
  position: number // character position in plain text
  /** Where the engine paints this hit. */
  locator?: Locator
}

/**
 * `engineHref`: the chapter whose engine open has landed, null before (or off reflow).
 * The list is the engine's `find`, and ReaderHighlights paints this list: hit i here is hit i painted.
 */
export function useInBookSearch(html: string, engineHref: string | null) {
  const [query, setQuery] = useState('')
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)
  // A new chapter starts at its first match: the old index could point past
  // the new list ("7 of 3") or at an arbitrary match.
  const [indexedHtml, setIndexedHtml] = useState(html)
  if (indexedHtml !== html) {
    setIndexedHtml(html)
    setActiveMatchIndex(0)
  }

  // An effect, not a memo: ReaderSection (a child) opens new html in its own effect, which runs first, so
  // the engine's text here is this html's. A new chapter waits for engineHref (its open landed).
  const [matches, setMatches] = useState<SearchMatch[]>([])
  useEffect(() => {
    const q = query.trim()
    const engine = mountedEngineFor(engineHref ?? undefined)?.engine
    setMatches(!engine || q.length < 2 ? [] : engine.find(q).map(({ locator, context }, index) => ({
      index, text: locator.text?.highlight ?? q, context, position: locator.locations.charOffset ?? 0, locator,
    })))
  }, [html, query, engineHref])

  const search = useCallback((q: string) => {
    setQuery(q)
    setActiveMatchIndex(0)
  }, [])

  const nextMatch = useCallback(() => {
    if (matches.length === 0) return
    setActiveMatchIndex((prev) => (prev + 1) % matches.length)
  }, [matches.length])

  const prevMatch = useCallback(() => {
    if (matches.length === 0) return
    setActiveMatchIndex((prev) => (prev - 1 + matches.length) % matches.length)
  }, [matches.length])

  const goToMatch = useCallback((index: number) => {
    if (index >= 0 && index < matches.length) {
      setActiveMatchIndex(index)
    }
  }, [matches.length])

  const clear = useCallback(() => {
    setQuery('')
    setActiveMatchIndex(0)
  }, [])

  return {
    query,
    matches,
    activeMatchIndex,
    activeMatch: matches[activeMatchIndex] || null,
    search,
    nextMatch,
    prevMatch,
    goToMatch,
    clear,
  }
}
