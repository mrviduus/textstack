import { describe, expect, it } from 'vitest'
import {
  MAX_CONTEXT, MAX_LABEL, MAX_MATCH, MAX_QUERY, MAX_RESULTS, MIN_QUERY, NO_SEARCH, SEARCH_FILL, readQuery, readSearchResults, searchItems, searchStart, searchTake,
} from './search.mjs'
import { HIGHLIGHT_FILL } from './highlights.mjs'
import { MAX_SELECTION_CFI } from './selection.mjs'

// #1315: the query, the page's result items, the hosts' reader of `search-results` (untrusted: the page renders the
// book) and the hosts' search state.

const CFI = 'epubcfi(/6/4!/4/2,/1:0,/1:5)'
const hit = (o: object = {}) => ({ cfi: CFI, pre: 'before ', match: 'Whale', post: ' after', label: 'Chapter 1', ...o })
const msg = (results: unknown, o: object = {}) => ({ type: 'search-results', key: 'ab', id: 3, results, done: false, more: false, ...o })

describe('v2 reader search', () => {
  it('readQuery_TrimmedAndOneSpaced_WithinItsLengths_ElseNull', () => {
    expect(readQuery('  white \n\t whale ')).toBe('white whale')
    expect(readQuery('a'.repeat(MIN_QUERY))).toBe('a'.repeat(MIN_QUERY))
    expect(readQuery('a'.repeat(MIN_QUERY - 1))).toBeNull()
    expect(readQuery(' a ')).toBeNull()
    expect(readQuery('a'.repeat(MAX_QUERY))).toHaveLength(MAX_QUERY)
    expect(readQuery('a'.repeat(MAX_QUERY + 1))).toBeNull()
    expect([readQuery(null), readQuery(undefined), readQuery(42), readQuery(['ab']), readQuery('')]).toEqual([null, null, null, null, null])
  })

  it('searchFill_IsNoHighlightColour', () => {
    expect(SEARCH_FILL).toMatch(/^#[0-9a-f]{6}$/)
    expect(Object.values(HIGHLIGHT_FILL)).not.toContain(SEARCH_FILL)
  })

  it('searchItems_FoliateHits_AsItems_ContextCutFromTheHitsSide', () => {
    const items = searchItems([
      { cfi: CFI, excerpt: { pre: 'a'.repeat(MAX_CONTEXT) + 'END', match: 'Whale', post: 'START' + 'b'.repeat(MAX_CONTEXT) } },
    ], '  Chapter 1 ')
    expect(items).toEqual([{ cfi: CFI, pre: ('a'.repeat(MAX_CONTEXT) + 'END').slice(-MAX_CONTEXT), match: 'Whale', post: ('START' + 'b'.repeat(MAX_CONTEXT)).slice(0, MAX_CONTEXT), label: 'Chapter 1' }])
    expect(items[0].pre.endsWith('END')).toBe(true)
    expect(items[0].post.startsWith('START')).toBe(true)
  })

  it('searchItems_MalformedHit_Dropped_MissingContextEmpty_LongStringsCut', () => {
    expect(searchItems([
      null, 'x', { cfi: 'not-a-cfi', excerpt: { match: 'a' } }, { cfi: CFI }, { cfi: CFI, excerpt: { match: '' } }, { cfi: CFI, excerpt: { match: 7 } },
      { cfi: 'epubcfi(' + '/2'.repeat(MAX_SELECTION_CFI), excerpt: { match: 'a' } },
      { cfi: CFI, excerpt: { match: 'm'.repeat(MAX_MATCH + 9) } },
    ], 'L'.repeat(MAX_LABEL + 9))).toEqual([{ cfi: CFI, pre: '', match: 'm'.repeat(MAX_MATCH), post: '', label: 'L'.repeat(MAX_LABEL) }])
    expect(searchItems('nope', undefined)).toEqual([])
    expect(searchItems([{ cfi: CFI, excerpt: { match: 'a' } }], { toString: () => 'x' })[0].label).toBe('')
  })

  it('readSearchResults_WellFormed_KeepsOnlyKnownFields', () => {
    expect(readSearchResults(msg([{ ...hit(), extra: 1 }], { done: true, more: true, other: 2 }))).toEqual({ key: 'ab', id: 3, results: [hit()], done: true, more: true })
    // A section with no title, a hit at the start of its text.
    expect(readSearchResults(msg([hit({ pre: '', post: '', label: '' })]))?.results).toEqual([hit({ pre: '', post: '', label: '' })])
  })

  it('readSearchResults_MalformedMessage_Null', () => {
    for (const m of [null, 'x', 5, {}, msg([hit()], { type: 'highlight-list' }), msg([hit()], { key: 5 }), msg([hit()], { id: '3' }), msg([hit()], { id: 1.5 }), msg([hit()], { id: Number.MAX_SAFE_INTEGER + 1 }), msg('x'), msg(undefined)])
      expect(readSearchResults(m)).toBeNull()
  })

  it('readSearchResults_MalformedItem_Dropped_TheRestKept', () => {
    const bad = [
      null, 'x', hit({ cfi: 'javascript:1' }), hit({ cfi: 5 }), hit({ cfi: 'epubcfi(' + '/2'.repeat(MAX_SELECTION_CFI) }),
      hit({ match: '' }), hit({ match: 5 }), hit({ match: 'm'.repeat(MAX_MATCH + 1) }),
      hit({ pre: 5 }), hit({ pre: 'p'.repeat(MAX_CONTEXT + 1) }), hit({ post: null }), hit({ post: 'p'.repeat(MAX_CONTEXT + 1) }),
      hit({ label: undefined }), hit({ label: 'l'.repeat(MAX_LABEL + 1) }),
    ]
    expect(readSearchResults(msg([...bad, hit({ match: 'kept' })]))?.results).toEqual([hit({ match: 'kept' })])
    // At their caps, kept.
    const edge = hit({ match: 'm'.repeat(MAX_MATCH), pre: 'p'.repeat(MAX_CONTEXT), post: 'q'.repeat(MAX_CONTEXT), label: 'l'.repeat(MAX_LABEL) })
    expect(readSearchResults(msg([edge]))?.results).toEqual([edge])
  })

  it('readSearchResults_DoneAndMore_OnlyTrueIsTrue_ItemsCapped', () => {
    expect(readSearchResults(msg([], { done: 'yes', more: 1 }))).toMatchObject({ done: false, more: false })
    const many = Array.from({ length: MAX_RESULTS + 5 }, (_, i) => hit({ post: String(i) }))
    const read = readSearchResults(msg(many))!.results
    expect(read).toHaveLength(MAX_RESULTS)
    expect(read.at(-1)!.post).toBe(String(MAX_RESULTS - 1))
  })

  it('searchStart_AQuery_ANewIdRunning_NoQuery_ANewIdDone', () => {
    expect(NO_SEARCH).toEqual({ id: 0, query: '', results: [], done: true, more: false })
    const a = searchStart(NO_SEARCH, ' white  whale ')
    expect(a).toEqual({ id: 1, query: 'white whale', results: [], done: false, more: false })
    // Too short, cleared, a new book: nothing runs, and the id still moves on (the older search's answers are dropped).
    expect(searchStart({ ...a, results: [hit()], more: true }, 'w')).toEqual({ id: 2, query: '', results: [], done: true, more: false })
    expect(searchStart(a, '')).toMatchObject({ id: 2, query: '', done: true })
  })

  it('searchTake_ItsOwnId_Appends_InOrder_UntilDone', () => {
    let s = searchStart(NO_SEARCH, 'whale')
    s = searchTake(s, readSearchResults(msg([hit({ post: '1' })], { id: 1 }))!)
    s = searchTake(s, readSearchResults(msg([hit({ post: '2' }), hit({ post: '3' })], { id: 1 }))!)
    expect(s.results.map((r) => r.post)).toEqual(['1', '2', '3'])
    expect(s.done).toBe(false)
    s = searchTake(s, readSearchResults(msg([], { id: 1, done: true, more: true }))!)
    expect(s).toMatchObject({ id: 1, query: 'whale', done: true, more: true })
    expect(s.results.map((r) => r.post)).toEqual(['1', '2', '3'])
  })

  it('searchTake_AnOlderSearchsAnswer_OrOneAfterTheEnd_ChangesNothing', () => {
    const first = searchStart(NO_SEARCH, 'whale')
    const second = searchStart(first, 'ahab')
    // The first search's answer arrives after the second was asked.
    expect(searchTake(second, readSearchResults(msg([hit()], { id: first.id }))!)).toBe(second)
    expect(searchTake(second, readSearchResults(msg([], { id: first.id, done: true }))!)).toBe(second)
    const ended = searchTake(second, readSearchResults(msg([hit()], { id: second.id, done: true }))!)
    expect(searchTake(ended, readSearchResults(msg([hit({ post: 'late' })], { id: second.id }))!)).toBe(ended)
    // Nothing asked (a cleared field): whatever comes is dropped.
    const cleared = searchStart(second, '')
    expect(searchTake(cleared, readSearchResults(msg([hit()], { id: cleared.id }))!)).toBe(cleared)
  })

  it('searchTake_NeverPastTheCap', () => {
    let s = searchStart(NO_SEARCH, 'the')
    const batch = Array.from({ length: MAX_RESULTS - 1 }, (_, i) => hit({ post: String(i) }))
    s = searchTake(s, readSearchResults(msg(batch, { id: 1 }))!)
    s = searchTake(s, readSearchResults(msg([hit({ post: 'last' }), hit({ post: 'over' })], { id: 1 }))!)
    expect(s.results).toHaveLength(MAX_RESULTS)
    expect(s.results.at(-1)!.post).toBe('last')
  })
})
