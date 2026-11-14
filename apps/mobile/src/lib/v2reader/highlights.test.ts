import { describe, expect, it } from 'vitest'
import {
  HIGHLIGHT_COLORS, HIGHLIGHT_FILL, MAX_LIST, MAX_LIST_TEXT, colorOf, highlightList, noteChange, noteOf, readHighlightList, readHighlightRemoved, sameRangeHighlight,
  readHighlightTap,
} from './highlights.mjs'
import { MAX_SELECTION_CFI, MAX_SELECTION_PX } from './selection.mjs'
import { takenWithoutBook } from './chrome.mjs'

// #1312: the palette, the page's list and the hosts' readers of the page's highlight messages (untrusted: the page
// renders the book).

const ID = '11111111-1111-4111-8111-111111111111'
const CFI = 'epubcfi(/6/4!/4/2,/1:0,/1:5)'
const item = (o: object = {}) => ({ id: ID, cfi: CFI, color: 'green', text: 'Hello', at: 5, ...o })
const listMsg = (highlights: unknown, o: object = {}) => ({ type: 'highlight-list', key: 'ab', highlights, ...o })

describe('v2 reader highlights', () => {
  it('palette_TheLegacyFourInTheirOrder_EachWithAFill', () => {
    expect(HIGHLIGHT_COLORS).toEqual(['yellow', 'green', 'pink', 'blue'])
    expect(HIGHLIGHT_COLORS.map((c) => /^#[0-9a-f]{6}$/.test(HIGHLIGHT_FILL[c]))).toEqual([true, true, true, true])
    // The server does not enumerate colours: one off the list (another client's) is drawn yellow, never as given.
    expect([colorOf('pink'), colorOf('mauve'), colorOf(undefined), colorOf('url(x)')]).toEqual(['pink', 'yellow', 'yellow', 'yellow'])
  })

  it('highlightList_DrawnOnly_InBookOrder_TiesByTime_TextCutByCodePoints', () => {
    const h = (id: string, cfi: string, at: number, text = id) => ({ id, cfi, at, selectedText: text, quote: text.slice(0, 3), color: 'blue' })
    const order: Record<string, number> = { a: 2, b: 1, c: 1, d: 0 }
    const compare = (x: string, y: string) => order[x] - order[y]
    const list = highlightList([h('a1', 'a', 1), h('b1', 'b', 9), h('c1', 'c', 3), h('d1', 'd', 1)], new Set(['a1', 'b1', 'c1']), compare)
    expect(list.map((x) => x.id)).toEqual(['c1', 'b1', 'a1'])
    expect(list[0]).toEqual({ id: 'c1', cfi: 'c', color: 'blue', text: 'c1', at: 3 })
    // Cut by code points: a surrogate pair is never split.
    const long = highlightList([h('e', 'a', 1, '😀'.repeat(MAX_LIST_TEXT + 5))], new Set(['e']), compare)[0].text
    expect(Array.from(long)).toHaveLength(MAX_LIST_TEXT)
    // A pre-#1078 highlight: its quote is the selection.
    expect(highlightList([{ id: 'o', cfi: 'a', quote: 'old', color: 'mauve' }], new Set(['o']), compare)[0]).toMatchObject({ text: 'old', color: 'yellow', at: null })
  })

  it('sameRangeHighlight_ExactlyADrawnOnesCfi_ThatOne_ElseNone', () => {
    const a = { id: 'a', cfi: 'epubcfi(/6/2!/4,/1:0,/1:5)' }, b = { id: 'b', cfi: 'epubcfi(/6/2!/4,/1:0,/1:6)' }
    expect(sameRangeHighlight([a, b], a.cfi, new Set(['a', 'b']))).toBe(a)
    // Not drawn (its text no longer there), or another range: none.
    expect(sameRangeHighlight([a, b], a.cfi, new Set(['b']))).toBeUndefined()
    expect(sameRangeHighlight([a, b], 'epubcfi(/6/2!/4,/1:0,/1:7)', new Set(['a', 'b']))).toBeUndefined()
  })

  it('readHighlightList_KnownFieldsOnly_MalformedItemsDropped', () => {
    expect(readHighlightList(listMsg([item({ extra: '<img>' })]))).toEqual({ key: 'ab', highlights: [item()] })
    const bad = [
      item({ id: 'a b' }), item({ id: '' }), item({ id: 'x'.repeat(65) }), item({ id: 7 }),
      item({ cfi: 'javascript:1' }), item({ cfi: `epubcfi(${'/4'.repeat(MAX_SELECTION_CFI)})` }),
      item({ text: 3 }), item({ text: 'x'.repeat(2 * MAX_LIST_TEXT + 1) }), null, 'x',
    ]
    expect(readHighlightList(listMsg([...bad, item({ color: '<script>', at: 'now' })]))!.highlights).toEqual([item({ color: 'yellow', at: null })])
    expect(readHighlightList(listMsg(Array.from({ length: MAX_LIST + 3 }, () => item())))!.highlights).toHaveLength(MAX_LIST)
  })

  it('readHighlightList_NotTheMessage_Null', () => {
    expect(readHighlightList(listMsg([], { type: 'store' }))).toBeNull()
    expect(readHighlightList(listMsg({}))).toBeNull()
    expect(readHighlightList(listMsg([], { key: 3 }))).toBeNull()
    expect(readHighlightList(null)).toBeNull()
  })

  it('readHighlightTap_IdBoxAndPoint_OrNull', () => {
    const rect = { x: 1, y: 2, w: 3, h: 4 }
    const tap = { type: 'highlight-tap', id: ID, rect, x: 10, y: 20 }
    expect(readHighlightTap({ ...tap, extra: 1 })).toEqual({ id: ID, rect, x: 10, y: 20 })
    for (const bad of [{ id: 'a b' }, { rect: null }, { rect: { ...rect, w: -1 } }, { x: MAX_SELECTION_PX + 1 }, { y: 'top' }, { type: 'tap' }]) {
      expect(readHighlightTap({ ...tap, ...bad })).toBeNull()
    }
  })

  it('readHighlightRemoved_KeyAndId_OrNull', () => {
    expect(readHighlightRemoved({ type: 'highlight-removed', key: 'ab', id: ID })).toEqual({ key: 'ab', id: ID })
    expect(readHighlightRemoved({ type: 'highlight-removed', key: 'ab', id: '../x' })).toBeNull()
    expect(readHighlightRemoved({ type: 'highlight-removed', id: ID })).toBeNull()
  })

  it('noteOf_TrimmedCappedBlankIsNone', () => {
    expect(noteOf('  a note \n')).toBe('a note')
    expect(noteOf('   ')).toBeNull()
    expect(noteOf(undefined)).toBeNull()
    // Never cut: a long note written elsewhere is kept whole by an edit here.
    const long = '😀'.repeat(6000)
    expect(noteOf(` ${long} `)).toBe(long)
  })

  it('noteChange_TheDraftTheEditorOpenedWith_NothingToWrite_ElseTheNote', () => {
    expect(noteChange('', null)).toBeUndefined()
    expect(noteChange('  kept ', 'kept')).toBeUndefined()
    expect(noteChange('', 'their note')).toBeNull()
    expect(noteChange('new', null)).toBe('new')
  })

  it('highlightTap_NoBookOnScreen_Dropped', () => {
    expect(takenWithoutBook('highlight-tap')).toBe(false)
    expect(takenWithoutBook('highlight-list')).toBe(true)
  })
})
