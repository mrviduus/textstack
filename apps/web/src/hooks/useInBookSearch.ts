import { useState, useCallback, useMemo } from 'react'
import { textWalker, findTextOffsets } from '@textstack/reader-overlay'
import { sanitizeHtml } from '../utils/sanitize'

export interface SearchMatch {
  index: number
  text: string
  context: string
  position: number // character position in plain text
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

export function useInBookSearch(html: string) {
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

  const matches = useMemo(() => {
    // Same rules as SearchOverlayLayer (trimmed, findTextOffsets).
    const q = query.trim()
    if (q.length < 2) return []
    return findTextOffsets(plainText, q).map((pos, index): SearchMatch => ({
      index,
      text: plainText.slice(pos, pos + q.length),
      context: getContextAround(plainText, pos, q.length),
      position: pos,
    }))
  }, [plainText, query])

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
