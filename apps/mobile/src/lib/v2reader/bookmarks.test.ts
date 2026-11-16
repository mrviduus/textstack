// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { BOOKMARK, BOOKMARK_TEXT, bookmarkList, bookmarkRange, bookmarkText, isBookmark, readBookmarkList, startsWithin } from './bookmarks.mjs'
import { foldText } from './store.mjs'
import { HIGHLIGHT_COLORS, highlightList } from './highlights.mjs'

/** `html` as the body; a range from `[startSel, startOffset]` to `[endSel, endOffset]` over the elements' first text nodes. */
function screen(html: string, from?: [string, number], to?: [string, number]): Range {
  document.body.innerHTML = html
  const r = document.createRange()
  r.selectNodeContents(document.body)
  if (from) r.setStart(document.querySelector(from[0])!.firstChild!, from[1])
  if (to) r.setEnd(document.querySelector(to[0])!.firstChild!, to[1])
  return r
}

const CFI = 'epubcfi(/6/4!/4/2,/1:0,/1:5)'
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

describe('v2 reader bookmarks', () => {
  it('bookmark_IsNotAHighlightColour', () => {
    expect(HIGHLIGHT_COLORS).not.toContain(BOOKMARK)
    expect(isBookmark({ color: 'bookmark' })).toBe(true)
    for (const color of ['yellow', 'Bookmark', '', null, undefined]) expect(isBookmark({ color })).toBe(false)
    expect(isBookmark(null)).toBe(false)
  })

  it('bookmarkRange_WholeBodyOnScreen_FirstWordsFromTheFirstNonSpace', () => {
    const r = bookmarkRange(screen('<h1>  Chapter One</h1>\n<p>It was a bright cold day.</p>'))!
    expect(r.toString()).toBe('Chapter One\nIt was a bright cold day.')
    expect(r.startContainer).toBe(document.querySelector('h1')!.firstChild)
    expect(r.startOffset).toBe(2)
  })

  it('bookmarkRange_ScreenStartsMidParagraph_StartsThereNotAtTheParagraph', () => {
    const r = bookmarkRange(screen('<p id="a">One two three.</p><p id="b">Four five.</p>', ['#a', 3]))!
    expect(r.toString()).toBe('two three.Four five.')
    expect([r.startContainer, r.startOffset]).toEqual([document.querySelector('#a')!.firstChild, 4])
  })

  it('bookmarkRange_NeverPastTheScreensEnd', () => {
    const r = bookmarkRange(screen('<p id="a">One two three.</p><p id="b">Four five.</p><p id="c">Six.</p>', ['#a', 0], ['#b', 4]))!
    expect(r.toString()).toBe('One two three.Four')
    expect([r.endContainer, r.endOffset]).toEqual([document.querySelector('#b')!.firstChild, 4])
  })

  it('bookmarkRange_LongText_CutAtTheCap_AcrossNodes', () => {
    const r = bookmarkRange(screen(`<p>${'a'.repeat(100)}</p><p>${'b'.repeat(100)}</p>`))!
    expect(r.toString()).toBe('a'.repeat(100) + 'b'.repeat(BOOKMARK_TEXT - 100))
    expect(bookmarkRange(screen('<p>abcdefgh</p>'), 3)!.toString()).toBe('abc')
  })

  it('bookmarkRange_CapInsideASurrogatePair_CutBeforeIt', () => {
    // 2 units, then a pair at units 2-3: a cap of 3 would keep the pair's first half alone.
    expect(bookmarkRange(screen('<p>ab\u{1F600}cd</p>'), 3)!.toString()).toBe('ab')
    expect(bookmarkRange(screen('<p>ab\u{1F600}cd</p>'), 4)!.toString()).toBe('ab\u{1F600}')
  })

  it('bookmarkRange_NoTrailingWhiteSpace_WhereverItEnds', () => {
    // The screen's own end, a blank node after the text, and a cap that lands right after a space.
    const r = bookmarkRange(screen('<p id="a">abc  </p><p>   </p>\n'))!
    expect(r.toString()).toBe('abc')
    expect([r.endContainer, r.endOffset]).toEqual([document.querySelector('#a')!.firstChild, 3])
    expect(bookmarkRange(screen('<p>ab cd</p>'), 3)!.toString()).toBe('ab')
    // White space inside the text is the text's.
    expect(bookmarkRange(screen('<p>ab  cd </p><p> ef</p>'))!.toString()).toBe('ab  cd  ef')
  })

  it('bookmarkRange_ScreenInsideOneTextNode_ThatPartOnly', () => {
    const r = bookmarkRange(screen('<p id="a">One two three four.</p>', ['#a', 3], ['#a', 13]))!
    expect(r.toString()).toBe('two three')
  })

  it('bookmarkRange_NoTextOnScreen_Null', () => {
    expect(bookmarkRange(screen('<p> \n </p><img alt="x"><p> </p>'))).toBeNull()
    expect(bookmarkRange(screen('<p id="a">One</p><p id="b">Two</p>', ['#a', 3], ['#b', 0]))).toBeNull()
    expect(bookmarkRange(null)).toBeNull()
    const collapsed = screen('<p id="a">One</p>', ['#a', 1], ['#a', 1])
    expect(bookmarkRange(collapsed)).toBeNull()
  })

  it('bookmarkRange_StyleOrScriptFirst_NotTheBookmarksText', () => {
    expect(bookmarkRange(screen('<style>p { color: red }</style><script>var x = 1</script><p>Words.</p>'))!.toString()).toBe('Words.')
  })

  it('bookmarkText_PiecesInDifferentBlocks_ASpaceBetween_NoneInsideABlock', () => {
    const r = bookmarkRange(screen('<h1>Chapter <i>One</i></h1><p><b>I</b>t was a <em>bright</em> cold day.</p><div>Next block</div>'))!
    expect(r.toString()).toBe('Chapter OneIt was a bright cold day.Next block')
    expect(bookmarkText(r)).toBe('Chapter One It was a bright cold day. Next block')
  })

  it('bookmarkText_WhiteSpaceAlreadyThere_NotDoubled', () => {
    expect(bookmarkText(bookmarkRange(screen('<h1>Chapter One</h1>\n<p>It was.</p><p> Then.</p>'))!)).toBe('Chapter One\nIt was. Then.')
  })

  it('bookmarkText_OnlyWhiteSpaceDiffersFromTheRangesText_SoRestoreStillFindsIt', () => {
    const r = bookmarkRange(screen('<h1>One</h1><p>Two <span>three</span></p><ul><li>four</li><li>five</li></ul>'))!
    expect(bookmarkText(r)).toBe('One Two three four five')
    expect(foldText(bookmarkText(r))).toBe(foldText(r.toString()))
  })

  it('bookmarkText_RangeStartsAndEndsInsideNodes_OnlyTheRangesText', () => {
    const visible = screen('<p id="a">One two</p><p id="b">three four</p><p>tail</p>', ['#a', 4], ['#b', 5])
    expect(bookmarkText(bookmarkRange(visible)!)).toBe('two three')
  })

  it('bookmarkText_ACdataSectionInTheRange_ItsTextKept_AsARangesOwnTextKeepsIt', () => {
    // A CDATA section is text to a range (DOM: a Text node); a label without it would not read as the text at the
    // CFI, and the bookmark would never restore. (jsdom's own Range text leaves it out, so the range is not asked here.)
    const doc = new DOMParser().parseFromString('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>One<![CDATA[ cdata ]]></p><p>Two</p></body></html>', 'application/xhtml+xml')
    const [one, two] = [doc.querySelector('p')!.firstChild!, doc.querySelectorAll('p')[1].firstChild!]
    const r = doc.createRange()
    r.setStart(one, 0)
    r.setEnd(two, 3)
    expect(bookmarkText(r)).toBe('One cdata Two')
  })

  it('bookmarkText_OneTextNode_ItsText', () => {
    expect(bookmarkText(bookmarkRange(screen('<p id="a">One two three four.</p>', ['#a', 3], ['#a', 13]))!)).toBe('two three')
  })

  it('startsWithin_AtOrAfterTheStartAndBeforeTheEnd', () => {
    const visible = screen('<p id="a">One two three.</p><p id="b">Four five.</p><p id="c">Six.</p>', ['#a', 4], ['#b', 4])
    const at = (sel: string, o: number) => {
      const r = document.createRange()
      r.setStart(document.querySelector(sel)!.firstChild!, o)
      r.setEnd(document.querySelector(sel)!.firstChild!, o + 1)
      return r
    }
    expect(startsWithin(visible, at('#a', 4))).toBe(true)    // the screen's first character
    expect(startsWithin(visible, at('#b', 3))).toBe(true)    // its last
    expect(startsWithin(visible, at('#a', 3))).toBe(false)   // the screen before
    expect(startsWithin(visible, at('#b', 4))).toBe(false)   // the next screen's first character
    expect(startsWithin(visible, at('#c', 0))).toBe(false)
  })

  it('startsWithin_AnotherDocumentsRange_False', () => {
    const visible = screen('<p id="a">One two three.</p>')
    const other = new DOMParser().parseFromString('<p>One two three.</p>', 'text/html')
    const r = other.createRange()
    r.selectNodeContents(other.body)
    expect(startsWithin(visible, r)).toBe(false)
  })

  it('bookmarkList_OnlyPlacedBookmarks_InBookOrder_TextCut', () => {
    const hl = [
      { id: 'b2', cfi: 'epubcfi(/6/8)', color: BOOKMARK, selectedText: 'second', at: 1 },
      { id: 'h1', cfi: 'epubcfi(/6/2)', color: 'yellow', selectedText: 'a highlight', at: 2 },
      { id: 'b1', cfi: 'epubcfi(/6/4)', color: BOOKMARK, selectedText: 'x'.repeat(300), at: 3 },
      { id: 'b3', cfi: 'epubcfi(/6/6)', color: BOOKMARK, selectedText: 'not found in this file', at: 4 },
      { id: 'b0', cfi: 'epubcfi(/6/8)', color: BOOKMARK, quote: 'same place, earlier', at: 0 },
    ]
    expect(bookmarkList(hl, new Set(['b0', 'b1', 'b2', 'h1']), cmp)).toEqual([
      { id: 'b1', cfi: 'epubcfi(/6/4)', text: 'x'.repeat(200), at: 3 },
      { id: 'b0', cfi: 'epubcfi(/6/8)', text: 'same place, earlier', at: 0 },
      { id: 'b2', cfi: 'epubcfi(/6/8)', text: 'second', at: 1 },
    ])
  })

  it('highlightList_NeverListsABookmark_EvenIfDrawn', () => {
    // The page never draws one; a host that lists highlights must not show one as a yellow highlight either way.
    const hl = [{ id: 'b1', cfi: CFI, color: BOOKMARK, selectedText: 'a bookmark' }, { id: 'h1', cfi: CFI, color: 'green', selectedText: 'a highlight' }]
    expect(highlightList(hl, new Set(['h1']), cmp).map((h) => h.id)).toEqual(['h1'])
  })

  it('readBookmarkList_ValidMessage_ItemsHereAndCan', () => {
    const m = { type: 'bookmark-list', key: 'abc', bookmarks: [{ id: 'b1', cfi: CFI, text: 'First words', at: 5, extra: 1 }], here: 'b1', can: true }
    expect(readBookmarkList(m)).toEqual({ key: 'abc', bookmarks: [{ id: 'b1', cfi: CFI, text: 'First words', at: 5 }], here: 'b1', can: true })
  })

  it('readBookmarkList_MalformedItemsDropped_HereOnlyIfListed_CanOnlyIfTrue', () => {
    const ok = { id: 'b1', cfi: CFI, text: 't', at: 'soon' }
    const m = {
      type: 'bookmark-list', key: 'abc', here: 'b9', can: 'yes',
      bookmarks: [ok, null, { ...ok, id: '<img>' }, { ...ok, id: 'b2', cfi: 'javascript:1' }, { ...ok, id: 'b3', text: 5 }, { ...ok, id: 'b4', text: 'x'.repeat(401) }],
    }
    expect(readBookmarkList(m)).toEqual({ key: 'abc', bookmarks: [{ id: 'b1', cfi: CFI, text: 't', at: null }], here: null, can: false })
    // `here` naming a dropped item is none.
    expect(readBookmarkList({ ...m, here: 'b2' })!.here).toBeNull()
  })

  it('readBookmarkList_NotABookmarkList_Null', () => {
    const m = { type: 'bookmark-list', key: 'abc', bookmarks: [], here: null, can: false }
    expect(readBookmarkList(m)).toEqual({ key: 'abc', bookmarks: [], here: null, can: false })
    for (const bad of [null, 'x', { ...m, type: 'highlight-list' }, { ...m, key: 5 }, { ...m, bookmarks: {} }]) expect(readBookmarkList(bad)).toBeNull()
  })
})
