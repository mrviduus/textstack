// In-book search (#1315): the query a host may send, the page's `search-results` items, the hosts' reader of that
// message and the hosts' state and status line (one rule for both). Pure, page and both hosts. The page renders
// untrusted book content: a host takes results only through `readSearchResults`, and shows their strings as text.
import { isCfi } from './selection.mjs'

/** The reader stopped typing for this long: the page is asked (a new search ends the one running). Both hosts. */
export const SEARCH_DEBOUNCE_MS = 300
/** Streamed results reach a host's screen at most this often (a long book answers once per section). */
export const SEARCH_RENDER_MS = 100
/**
 * A query is searched from this many characters (the legacy web reader's rule), counted as `queryLength` counts them;
 * one is enough in a script written without spaces between words (`NO_SPACES`: a one-character Chinese, Japanese,
 * Korean or Thai word is a word). At most `MAX_QUERY` UTF-16 units (a field's `maxLength`).
 */
export const MIN_QUERY = 2
export const MAX_QUERY = 100
/**
 * A search stops at this many hits ("the" in a long book has tens of thousands; each is a row in a host's list and an
 * overlay in its section): the page asks foliate for one more, which proves there are more, and foliate matches,
 * registers and draws nothing past that one. ponytail: no paging past it.
 */
export const MAX_RESULTS = 500
/** Caps of a result's strings (display only): the text before and after the hit, the hit, its section's title. */
export const MAX_CONTEXT = 60
export const MAX_MATCH = 2 * MAX_QUERY
export const MAX_LABEL = 200
/** What the page draws over every hit of the query (foliate's highlight at its .3 opacity); none of the highlight colours. */
export const SEARCH_FILL = '#f97316'

/** Thai, Hangul, Hiragana and Katakana, Han: scripts whose words are not set apart by spaces. Ranges, not `\p{Script=}`: one rule in every engine a host runs on. */
const NO_SPACES = /[\u0E00-\u0E7F\u1100-\u11FF\u3040-\u30FF\u3130-\u318F\u31F0-\u31FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\u{20000}-\u{323AF}]/u
/** What joins the character before it: combining marks, the zero-width joiner, variation selectors, emoji skin tones. */
const JOINED = /[\p{M}\u200D\uFE00-\uFE0F\u{1F3FB}-\u{1F3FF}]/gu
/**
 * The characters of a query as a reader counts them: code points, without the ones that only join or modify the one
 * before (a decomposed "é" and one emoji with a skin tone are one each). Not `Intl.Segmenter`: the Android host's
 * engine has none, and the hosts and the page must agree on what a query is (a host that asked for a search the page
 * refuses would wait for it for ever).
 */
export const queryLength = (t) => Array.from(t.replace(JOINED, '')).length

/** A query as searched: whitespace runs as one space (the page's matcher reads the book so), trimmed; null: not searched. */
export function readQuery(q) {
  const t = typeof q === 'string' ? q.replace(/\s+/g, ' ').trim() : ''
  return t.length <= MAX_QUERY && queryLength(t) >= (NO_SPACES.test(t) ? 1 : MIN_QUERY) ? t : null
}

/**
 * The page's `search-results` items from foliate's hits of one section (`{ cfi, excerpt: { pre, match, post }, label }`,
 * `label` the contents entry the hit is under): `{ cfi, pre, match, post, label }`, strings cut to their caps (context
 * from the hit's side). Whitespace runs in the hit are one space, as foliate already leaves the context: a hit over a
 * source line break is listed on one line (its CFI still points at the book's own text).
 */
export function searchItems(subitems) {
  const items = []
  for (const s of Array.isArray(subitems) ? subitems : []) {
    const { pre, match, post } = s?.excerpt ?? {}
    if (!isCfi(s?.cfi) || typeof match !== 'string' || !match) continue
    const label = typeof s.label === 'string' ? s.label.trim().slice(0, MAX_LABEL) : ''
    items.push({ cfi: s.cfi, pre: String(pre ?? '').slice(-MAX_CONTEXT), match: match.replace(/\s+/g, ' ').slice(0, MAX_MATCH), post: String(post ?? '').slice(0, MAX_CONTEXT), label })
  }
  return items
}

/**
 * A host's read of `search-results`: `{ key, id, results, done, more, incomplete }`, malformed items dropped; null for
 * a malformed message. `id` is the host's own (echoed), `done` the search's end, `more` that a hit past `MAX_RESULTS`
 * exists, `incomplete` that part of the book could not be read.
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
  return { key: m.key, id: m.id, results, done: m.done === true, more: m.more === true, incomplete: m.incomplete === true }
}

/** A host's search before any book: nothing to search, nothing asked, nothing running. */
export const NO_SEARCH = Object.freeze({ id: 0, query: '', results: [], done: true, more: false, incomplete: false, searchable: false })

/**
 * The reader typed `raw` ('' clears): a new search under the next id, so whatever the page still sends for an older
 * one is dropped. A host sends the page `search(next.query || null, next.id)`.
 */
export function searchStart(s, raw) {
  const query = readQuery(raw) ?? ''
  return { id: s.id + 1, query, results: [], done: !query, more: false, incomplete: false, searchable: s.searchable }
}

/**
 * An open starts, or the book is closed: its search ends and nothing is searchable until the next `opened` says so
 * (a search asked of the page meanwhile would be for the book before, and never answered for this one). The id
 * stays: an ended search takes no answer, and the next one asked moves it on.
 */
export const searchReset = (s) => ({ id: s.id, query: '', results: [], done: true, more: false, incomplete: false, searchable: false })

/** The page's `opened`: search is offered only where it says strictly `true` (not a CBZ, not a PDF). */
export const searchOpened = (s, opened) => ({ ...s, searchable: opened?.searchable === true })

/** `r` (through `readSearchResults`) joins the search it answers: one of an older id, or after its end, changes nothing. */
export function searchTake(s, r) {
  if (r.id !== s.id || s.done) return s
  return { ...s, results: [...s.results, ...r.results].slice(0, MAX_RESULTS), done: r.done, more: r.more, incomplete: r.incomplete }
}

/**
 * The two lines under the field, for both hosts. `status`, a key each host has a string for: '' (nothing typed, or a
 * query typed that the page was not asked yet: the debounce), `tooShort` (typed, and no query: `readQuery`),
 * `searching`, `none`, `count`, or `more` (the first `MAX_RESULTS` of more). `incomplete`: the search ended and part of
 * the book could not be read. `typed`: the field's text.
 */
export function searchStatusKeys(search, typed) {
  const incomplete = search.done && search.incomplete
  if (!search.query) return { status: typeof typed === 'string' && typed.trim() && readQuery(typed) === null ? 'tooShort' : '', incomplete }
  if (!search.done) return { status: 'searching', incomplete }
  if (!search.results.length) return { status: 'none', incomplete }
  return { status: search.more ? 'more' : 'count', incomplete }
}

/**
 * When a host puts its search on screen: at once for an end (`now`), else at most once per `SEARCH_RENDER_MS`, so a
 * book of hundreds of sections is not hundreds of renders of the whole reader. `render` reads the host's latest search.
 */
export function createSearchRenders(render, ms = SEARCH_RENDER_MS) {
  let timer = null
  return (now) => {
    if (now) {
      clearTimeout(timer)
      timer = null
      return render()
    }
    timer ??= setTimeout(() => {
      timer = null
      render()
    }, ms)
  }
}
