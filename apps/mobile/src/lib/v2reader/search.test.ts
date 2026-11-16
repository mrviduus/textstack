import { describe, expect, it, vi } from 'vitest'
import {
  MAX_CONTEXT, MAX_LABEL, MAX_MATCH, MAX_QUERY, MAX_RESULTS, MIN_QUERY, NO_SEARCH, SEARCH_DEBOUNCE_MS, SEARCH_FILL, queryLength, readQuery, readSearchResults, searchItems, searchOpened, searchReset,
  searchStart, searchStatusKeys, searchTake, createSearchRenders, SEARCH_RENDER_MS,
} from './search.mjs'
import { HIGHLIGHT_FILL } from './highlights.mjs'
import { MAX_SELECTION_CFI, isCfi } from './selection.mjs'

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

  it('readQuery_CountsCharactersAsAReaderDoes_OneIsEnoughWhereWordsHaveNoSpaces', () => {
    // One letter, one emoji (with a skin tone, with a variation selector), one decomposed "é": one character each, not searched.
    for (const one of ['a', 'я', '😀', '👍🏽', '❤️', 'e\u0301']) {
      expect(queryLength(one)).toBe(1)
      expect(readQuery(one)).toBeNull()
    }
    // Two of them are.
    expect(readQuery('e\u0301e\u0301')).toBe('e\u0301e\u0301')
    expect(readQuery('😀😀')).toBe('😀😀')
    // A one-character word in Han, Hiragana, Katakana, Hangul and Thai is searched.
    for (const word of ['水', '\u{20000}', 'の', 'ア', '물', 'ไ']) expect(readQuery(word)).toBe(word)
    // A long query is still measured in UTF-16 units (a field's maxLength).
    expect(readQuery('水'.repeat(MAX_QUERY))).toHaveLength(MAX_QUERY)
    expect(readQuery('水'.repeat(MAX_QUERY + 1))).toBeNull()
    expect(readQuery('😀'.repeat(MAX_QUERY / 2 + 1))).toBeNull()
  })

  it('isCfi_TheSchemeCapped_OneRuleForHighlightsAndSearch', () => {
    expect([isCfi('epubcfi(/6/2)'), isCfi('epubcfi(' + '/2'.repeat(MAX_SELECTION_CFI)), isCfi('javascript:1'), isCfi(null), isCfi(5)]).toEqual([true, false, false, false, false])
  })

  it('debounce_OneValueForBothHosts', () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(300)
  })

  it('searchFill_IsNoHighlightColour', () => {
    expect(SEARCH_FILL).toMatch(/^#[0-9a-f]{6}$/)
    expect(Object.values(HIGHLIGHT_FILL)).not.toContain(SEARCH_FILL)
  })

  it('searchItems_FoliateHits_AsItems_ContextCutFromTheHitsSide', () => {
    const items = searchItems([
      { cfi: CFI, excerpt: { pre: 'a'.repeat(MAX_CONTEXT) + 'END', match: 'Whale', post: 'START' + 'b'.repeat(MAX_CONTEXT) }, label: '  Chapter 1 ' },
    ])
    expect(items).toEqual([{ cfi: CFI, pre: ('a'.repeat(MAX_CONTEXT) + 'END').slice(-MAX_CONTEXT), match: 'Whale', post: ('START' + 'b'.repeat(MAX_CONTEXT)).slice(0, MAX_CONTEXT), label: 'Chapter 1' }])
    expect(items[0].pre.endsWith('END')).toBe(true)
    expect(items[0].post.startsWith('START')).toBe(true)
  })

  it('searchItems_MalformedHit_Dropped_MissingContextEmpty_LongStringsCut', () => {
    expect(searchItems([
      null, 'x', { cfi: 'not-a-cfi', excerpt: { match: 'a' } }, { cfi: CFI }, { cfi: CFI, excerpt: { match: '' } }, { cfi: CFI, excerpt: { match: 7 } },
      { cfi: 'epubcfi(' + '/2'.repeat(MAX_SELECTION_CFI), excerpt: { match: 'a' } },
      { cfi: CFI, excerpt: { match: 'm'.repeat(MAX_MATCH + 9) }, label: 'L'.repeat(MAX_LABEL + 9) },
    ])).toEqual([{ cfi: CFI, pre: '', match: 'm'.repeat(MAX_MATCH), post: '', label: 'L'.repeat(MAX_LABEL) }])
    expect(searchItems('nope')).toEqual([])
    expect(searchItems([{ cfi: CFI, excerpt: { match: 'a' }, label: { toString: () => 'x' } }, { cfi: CFI, excerpt: { match: 'a' } }]).map((i) => i.label)).toEqual(['', ''])
    // Each hit has its own contents entry: two in one section may differ.
    expect(searchItems([{ cfi: CFI, excerpt: { match: 'a' }, label: 'One' }, { cfi: CFI, excerpt: { match: 'a' }, label: 'Two' }]).map((i) => i.label)).toEqual(['One', 'Two'])
  })

  it('readSearchResults_WellFormed_KeepsOnlyKnownFields', () => {
    expect(readSearchResults(msg([{ ...hit(), extra: 1 }], { done: true, more: true, other: 2 }))).toEqual({ key: 'ab', id: 3, results: [hit()], done: true, more: true, incomplete: false })
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
    expect(readSearchResults(msg([], { done: 'yes', more: 1, incomplete: 'yes' }))).toMatchObject({ done: false, more: false, incomplete: false })
    expect(readSearchResults(msg([], { done: true, incomplete: true }))).toMatchObject({ done: true, incomplete: true })
    const many = Array.from({ length: MAX_RESULTS + 5 }, (_, i) => hit({ post: String(i) }))
    const read = readSearchResults(msg(many))!.results
    expect(read).toHaveLength(MAX_RESULTS)
    expect(read.at(-1)!.post).toBe(String(MAX_RESULTS - 1))
  })

  it('searchStart_AQuery_ANewIdRunning_NoQuery_ANewIdDone', () => {
    expect(NO_SEARCH).toEqual({ id: 0, query: '', results: [], done: true, more: false, incomplete: false, searchable: false })
    const a = searchStart(NO_SEARCH, ' white  whale ')
    expect(a).toEqual({ id: 1, query: 'white whale', results: [], done: false, more: false, incomplete: false, searchable: false })
    // Too short, cleared, a new book: nothing runs, and the id still moves on (the older search's answers are dropped).
    expect(searchStart({ ...a, results: [hit()], more: true, incomplete: true, searchable: true }, 'w')).toEqual({ id: 2, query: '', results: [], done: true, more: false, incomplete: false, searchable: true })
    expect(searchStart(a, '')).toMatchObject({ id: 2, query: '', done: true })
  })

  it('searchTake_ItsOwnId_Appends_InOrder_UntilDone', () => {
    let s = searchStart(NO_SEARCH, 'whale')
    s = searchTake(s, readSearchResults(msg([hit({ post: '1' })], { id: 1 }))!)
    s = searchTake(s, readSearchResults(msg([hit({ post: '2' }), hit({ post: '3' })], { id: 1 }))!)
    expect(s.results.map((r) => r.post)).toEqual(['1', '2', '3'])
    expect(s.done).toBe(false)
    expect(s.incomplete).toBe(false)
    s = searchTake(s, readSearchResults(msg([], { id: 1, done: true, more: true, incomplete: true }))!)
    expect(s).toMatchObject({ id: 1, query: 'whale', done: true, more: true, incomplete: true })
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

  it('searchReset_AnOpenStartsOrTheBookCloses_NothingSearchable_UntilOpenedSaysStrictlyTrue', () => {
    const reading = searchTake(searchStart(searchOpened(NO_SEARCH, { searchable: true }), 'whale'), readSearchResults(msg([hit()], { id: 1 }))!)
    expect(reading).toMatchObject({ searchable: true, query: 'whale', done: false })
    // The next open starts: the previous book's button must not stay live while the next one opens.
    const opening = searchReset(reading)
    expect(opening).toEqual({ id: 1, query: '', results: [], done: true, more: false, incomplete: false, searchable: false })
    // Whatever the page still answers for the previous book's search is dropped.
    expect(searchTake(opening, readSearchResults(msg([hit()], { id: 1, done: true }))!)).toBe(opening)
    expect(searchOpened(opening, { searchable: true })).toMatchObject({ searchable: true, id: 1 })
    // The next book's first search has an id of its own.
    expect(searchStart(searchOpened(opening, { searchable: true }), 'ahab').id).toBe(2)
    for (const opened of [{}, { searchable: false }, { searchable: 'true' }, { searchable: 1 }, null, undefined]) expect(searchOpened(searchOpened(opening, { searchable: true }), opened).searchable).toBe(false)
    // A new query on a searchable book keeps it searchable.
    expect(searchStart(searchOpened(opening, { searchable: true }), 'ahab').searchable).toBe(true)
  })

  it('searchStatusKeys_NothingTyped_TooShort_Searching_None_Count_More_AndIncompleteOnceEnded', () => {
    const answered = (o: object, hits = [hit()]) => searchTake(searchStart(NO_SEARCH, 'whale'), readSearchResults(msg(hits, { id: 1, ...o }))!)
    const status = (s: Parameters<typeof searchStatusKeys>[0], typed: unknown) => searchStatusKeys(s, typed).status
    expect(status(NO_SEARCH, '')).toBe('')
    expect(status(NO_SEARCH, '   ')).toBe('')
    expect(status(NO_SEARCH, undefined)).toBe('')
    // Typed, and no query (one letter): said, not left empty.
    expect(status(searchStart(NO_SEARCH, 'w'), 'w')).toBe('tooShort')
    expect(status(NO_SEARCH, ' w ')).toBe('tooShort')
    // A query typed that the page was not asked yet (the debounce): nothing is said, least of all "too short".
    expect(status(NO_SEARCH, 'whale')).toBe('')
    expect(status(NO_SEARCH, '水')).toBe('')
    expect(status(searchStart(NO_SEARCH, 'whale'), 'whale')).toBe('searching')
    expect(status(answered({}), 'whale')).toBe('searching')
    expect(status(answered({ done: true }, []), 'whale')).toBe('none')
    expect(status(answered({ done: true }), 'whale')).toBe('count')
    expect(status(answered({ done: true, more: true }), 'whale')).toBe('more')
    // The search asked stands while the reader types on (until the debounce asks again).
    expect(status(answered({ done: true }), 'w')).toBe('count')
    // Part of the book unread: only once the search ended.
    expect(searchStatusKeys(answered({ done: true, incomplete: true }), 'whale')).toEqual({ status: 'count', incomplete: true })
    expect(searchStatusKeys(answered({ done: true, incomplete: true }, []), 'whale')).toEqual({ status: 'none', incomplete: true })
    expect(searchStatusKeys(answered({ incomplete: true }), 'whale')).toEqual({ status: 'searching', incomplete: false })
    expect(searchStatusKeys(answered({ done: true }), 'whale').incomplete).toBe(false)
    expect(searchStatusKeys(NO_SEARCH, '').incomplete).toBe(false)
  })

  it('searchItems_TheHitOneSpaced_ALineBreakInTheSourceIsNotListed', () => {
    expect(searchItems([{ cfi: CFI, excerpt: { pre: 'a ', match: 'stone\n      wall\tstands', post: ' b' } }])[0]).toMatchObject({ pre: 'a ', match: 'stone wall stands', post: ' b' })
  })

  it('createSearchRenders_StreamedAtMostOncePerInterval_AnEndAtOnce', () => {
    vi.useFakeTimers()
    try {
      const render = vi.fn()
      const renders = createSearchRenders(render)
      renders(false)
      renders(false)
      renders(false)
      expect(render).toHaveBeenCalledTimes(0)
      vi.advanceTimersByTime(SEARCH_RENDER_MS - 1)
      expect(render).toHaveBeenCalledTimes(0)
      vi.advanceTimersByTime(1)
      expect(render).toHaveBeenCalledTimes(1)
      // The next batch waits its own interval.
      renders(false)
      vi.advanceTimersByTime(SEARCH_RENDER_MS)
      expect(render).toHaveBeenCalledTimes(2)
      // An end is shown at once, and the pending render does not come a second time.
      renders(false)
      renders(true)
      expect(render).toHaveBeenCalledTimes(3)
      vi.advanceTimersByTime(SEARCH_RENDER_MS * 2)
      expect(render).toHaveBeenCalledTimes(3)
      // And the one after an end is scheduled again.
      renders(false)
      vi.advanceTimersByTime(SEARCH_RENDER_MS)
      expect(render).toHaveBeenCalledTimes(4)
    } finally {
      vi.useRealTimers()
    }
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
