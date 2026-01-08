import { useState, useCallback, useMemo } from 'react'

export interface SearchMatch {
  index: number
  text: string
  context: string
  position: number // character position in plain text
}

function extractPlainText(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent || div.innerText || ''
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

  const plainText = useMemo(() => extractPlainText(html), [html])

  const matches = useMemo(() => {
    if (!query || query.length < 2) return []

    const results: SearchMatch[] = []
    const lowerText = plainText.toLowerCase()
    const lowerQuery = query.toLowerCase()

    let pos = 0
    let index = 0
    while ((pos = lowerText.indexOf(lowerQuery, pos)) !== -1) {
      const matchText = plainText.slice(pos, pos + query.length)
      results.push({
        index,
        text: matchText,
        context: getContextAround(plainText, pos, query.length),
        position: pos,
      })
      pos += 1
      index += 1
    }

    return results
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
