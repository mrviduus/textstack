// In-book search (#1315): the query a host may send, the page's `search-results` items, the hosts' reader of that
// message and the hosts' state (one rule for both). Pure, page and both hosts. The page renders untrusted book
// content: a host takes results only through `readSearchResults`, and shows their strings as text.
import { MAX_SELECTION_CFI } from './selection.mjs'

/** A query is searched from this many characters (the legacy web reader's rule) up to this many. */
export const MIN_QUERY = 2
export const MAX_QUERY = 100
/**
 * ponytail: a search stops at this many hits ("the" in a long book has tens of thousands; each is a row in a host's
 * list and an overlay in its section). Paged results if readers need the rest.
 */
export const MAX_RESULTS = 500
/** Caps of a result's strings (display only): the text before and after the hit, the hit, its section's title. */
export const MAX_CONTEXT = 60
export const MAX_MATCH = 2 * MAX_QUERY
export const MAX_LABEL = 200
/** What the page draws over every hit of the query (foliate's highlight at its .3 opacity); none of the highlight colours. */
export const SEARCH_FILL = '#f97316'

const isCfi = (c) => typeof c === 'string' && c.length <= MAX_SELECTION_CFI && c.startsWith('epubcfi(')

/** A query as searched: whitespace runs as one space (the page's matcher reads the book so), trimmed; null: not searched. */
export function readQuery(q) {
  const t = typeof q === 'string' ? q.replace(/\s+/g, ' ').trim() : ''
  return t.length >= MIN_QUERY && t.length <= MAX_QUERY ? t : null
}

/**
 * The page's `search-results` items from foliate's hits of one section (`{ cfi, excerpt: { pre, match, post } }`),
 * `label` its contents title: `{ cfi, pre, match, post, label }`, strings cut to their caps (context from the hit's side).
 */
export function searchItems(subitems, label) {
  const l = typeof label === 'string' ? label.trim().slice(0, MAX_LABEL) : ''
  const items = []
  for (const s of Array.isArray(subitems) ? subitems : []) {
    const { pre, match, post } = s?.excerpt ?? {}
    if (!isCfi(s?.cfi) || typeof match !== 'string' || !match) continue
    items.push({ cfi: s.cfi, pre: String(pre ?? '').slice(-MAX_CONTEXT), match: match.slice(0, MAX_MATCH), post: String(post ?? '').slice(0, MAX_CONTEXT), label: l })
  }
  return items
}

/**
 * A host's read of `search-results`: `{ key, id, results, done, more }`, malformed items dropped; null for a malformed
 * message. `id` is the host's own (echoed), `done` the search's end, `more` that it stopped at `MAX_RESULTS`.
 */
export function readSearchResults(m) {
  if (!m || typeof m !== 'object' || m.type !== 'search-results' || typeof m.key !== 'string' || !Number.isSafeInteger(m.id) || !Array.isArray(m.results)) return null
  const results = []
  for (const r of m.results.slice(0, MAX_RESULTS)) {
    if (!r || typeof r !== 'object' || !isCfi(r.cfi) || typeof r.match !== 'string' || !r.match || r.match.length > MAX_MATCH) continue
    if (typeof r.pre !== 'string' || r.pre.length > MAX_CONTEXT || typeof r.post !== 'string' || r.post.length > MAX_CONTEXT) continue
    if (typeof r.label !== 'string' || r.label.length > MAX_LABEL) continue
    results.push({ cfi: r.cfi, pre: r.pre, match: r.match, post: r.post, label: r.label })
  }
  return { key: m.key, id: m.id, results, done: m.done === true, more: m.more === true }
}

/** A host's search before any query: nothing asked, nothing running. */
export const NO_SEARCH = Object.freeze({ id: 0, query: '', results: [], done: true, more: false })

/**
 * The reader typed `raw` (or the book changed: ''): a new search under the next id, so whatever the page still sends
 * for an older one is dropped. A host sends the page `search(next.query || null, next.id)`.
 */
export function searchStart(s, raw) {
  const query = readQuery(raw) ?? ''
  return { id: s.id + 1, query, results: [], done: !query, more: false }
}

/** `r` (through `readSearchResults`) joins the search it answers: one of an older id, or after its end, changes nothing. */
export function searchTake(s, r) {
  if (r.id !== s.id || s.done) return s
  return { ...s, results: [...s.results, ...r.results].slice(0, MAX_RESULTS), done: r.done, more: r.more }
}
