export function normalizeForSearch(s: string | null | undefined): string {
  if (!s) return ''
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

export interface SearchableBook {
  title?: string | null
  author?: string | null
  tags?: string[] | null
}

const TAG_RE = /\btag:([a-z0-9-]+)\b/gi

export interface ParsedQuery {
  tags: string[]
  text: string
}

export function parseQuery(q: string): ParsedQuery {
  const tags: string[] = []
  const lowered = (q || '').toLowerCase()
  for (const m of lowered.matchAll(TAG_RE)) tags.push(m[1])
  const text = lowered.replace(TAG_RE, '').replace(/\s+/g, ' ').trim()
  return { tags, text }
}

export function matchesQuery(book: SearchableBook, query: string): boolean {
  const { tags, text } = parseQuery(query)
  if (tags.length > 0) {
    const bookTags = new Set((book.tags ?? []).map((t) => t.toLowerCase()))
    if (!tags.every((t) => bookTags.has(t))) return false
  }
  if (!text) return true
  const haystack = `${normalizeForSearch(book.title)} ${normalizeForSearch(book.author)}`
  return text.split(/\s+/).every((term) => haystack.includes(normalizeForSearch(term)))
}
