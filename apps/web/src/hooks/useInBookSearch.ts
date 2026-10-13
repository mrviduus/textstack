import { useState, useCallback, useMemo, useEffect } from 'react'
import { textWalker, findTextOffsets } from '@textstack/reader-overlay'
import { sanitizeHtml } from '../utils/sanitize'
import { mountedEngineFor } from '../lib/readerEngine'
import type { Locator } from '@textstack/reader-engine'

export interface SearchMatch {
  index: number
  text: string
  context: string
  position: number // character position in plain text
  /** READER_ENGINE: where the engine paints this hit. */
  locator?: Locator
}

// The text the overlay walks: the rendered (sanitized) chapter, script/style
// skipped — so the list here and the painted matches count the same things.
function extractPlainText(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = sanitizeHtml(html)
  for (const text of textWalker(div, function* (strings) { yield strings.join('') })) return text
  return ''
}

function getContextAround(text: string, position: number, matchLength: number, contextSize = 40): string {
  const start = Math.max(0, position - contextSize)
  const end = Math.min(text.length, position + matchLength + contextSize)

  let context = ''
  if (start > 0) context += '...'
  context += text.slice(start, end)
  if (end < text.length) context += '...'

  return context
}

/**
 * `engineHref` (READER_ENGINE; undefined = off): the chapter whose engine open has landed, null before.
 * The list is then the engine's `find`, and ReaderHighlights paints this list: hit i here is hit i painted.
 */
export function useInBookSearch(html: string, engineHref?: string | null) {
  const [query, setQuery] = useState('')
  const [activeMatchIndex, setActiveMatchIndex] = useState(0)
  // A new chapter starts at its first match: the old index could point past
  // the new list ("7 of 3") or at an arbitrary match.
  const [indexedHtml, setIndexedHtml] = useState(html)
  if (indexedHtml !== html) {
    setIndexedHtml(html)
    setActiveMatchIndex(0)
  }

  const plainText = useMemo(() => extractPlainText(html), [html])

  const textMatches = useMemo(() => {
    // Same rules as SearchOverlayLayer (trimmed, findTextOffsets).
    const q = query.trim()
    if (q.length < 2 || engineHref !== undefined) return []
    return findTextOffsets(plainText, q).map((pos, index): SearchMatch => ({
      index,
      text: plainText.slice(pos, pos + q.length),
      context: getContextAround(plainText, pos, q.length),
      position: pos,
    }))
  }, [plainText, query, engineHref])

  // An effect, not a memo: ReaderSection (a child) opens new html in its own effect, which runs first, so
  // the engine's text here is this html's. A new chapter waits for engineHref (its open landed).
  const [engineMatches, setEngineMatches] = useState<SearchMatch[]>([])
  useEffect(() => {
    if (engineHref === undefined) return
    const q = query.trim()
    const engine = mountedEngineFor(engineHref ?? undefined)?.engine
    setEngineMatches(!engine || q.length < 2 ? [] : engine.find(q).map(({ locator, context }, index) => ({
      index, text: locator.text?.highlight ?? q, context, position: locator.locations.charOffset ?? 0, locator,
    })))
  }, [html, query, engineHref])
  const matches = engineHref === undefined ? textMatches : engineMatches

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
