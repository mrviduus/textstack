// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { BOOKMARK_COLOR as BOOKMARK } from '../../shared/src/reader/pageStore'
import { BOOKMARK_TEXT, atTop, lineCount, bookmarkList, bookmarkRange, bookmarkText, isBookmark, readBookmarkList, startsWithin } from './bookmarks.mjs'
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

  it('bookmarkRangeAndText_AStyleScriptOrNoscriptInsideTheFirstWords_NotInTheLabel_NorCounted', () => {
    // text.ts's text nodes: what is not the book's text is neither kept nor counted against the cap.
    const html = `<p>One <style>p { color: red }</style>two <script>var x = 1</script>three<noscript>no script here</noscript> four ${'x'.repeat(200)}</p>`
    const r = bookmarkRange(screen(html))!
    const label = bookmarkText(r)
    expect(label).toBe(`One two three four ${'x'.repeat(BOOKMARK_TEXT - 19)}`)
    expect(label).toHaveLength(BOOKMARK_TEXT)
  })

  it('bookmarkText_LinesSeparatedByABr_ASpaceBetweenThem', () => {
    expect(bookmarkText(bookmarkRange(screen('<p>Line one<br>Line two<br/> Line three</p>'))!)).toBe('Line one Line two Line three')
    // A <br> elsewhere in the block separates nothing here: after both pieces, or before both.
    expect(bookmarkText(bookmarkRange(screen('<p><b>W</b>ord and<br>next</p>'))!)).toBe('Word and next')
    expect(bookmarkText(bookmarkRange(screen('<p>one<br><b>t</b>wo</p>'))!)).toBe('one two')
  })

  it('bookmarkText_ARangeEndingAtTheNextBlocksStart_NoTrailingSpace', () => {
    const r = screen('<p id="a">One two</p><p id="b">three</p>', ['#a', 0], ['#b', 0])
    expect(bookmarkText(r)).toBe('One two')
  })

  it('bookmarkRange_BlankScreenStartingInsideANode_Null', () => {
    expect(bookmarkRange(screen('<p id="a">One   </p><p> </p>', ['#a', 3]))).toBeNull()
  })

  it('bookmarkText_OneTextNode_ItsText', () => {
    expect(bookmarkText(bookmarkRange(screen('<p id="a">One two three four.</p>', ['#a', 3], ['#a', 13]))!)).toBe('two three')
  })

  describe('at the top of the screen (by the layout: rects given here, the live ones in the format check)', () => {
    // Three paragraphs of one text node each; a "layout" of 40 characters per line, lines 20 apart, 14 high.
    const HTML = `<p id="a">${'a'.repeat(120)}</p><p id="b">${'b'.repeat(120)}</p><p id="c">${'c'.repeat(120)}</p>`
    const lineOf = (node: Node, offset: number) => ['a', 'b', 'c'].indexOf((node.parentElement as HTMLElement).id) * 3 + Math.floor(offset / 40)
    /** One rect per line the range touches (its last character's line included, not the position after it). */
    const rects = (vertical = false) => (r: Range) => {
      const [from, to] = [lineOf(r.startContainer, r.startOffset), lineOf(r.endContainer, Math.max(r.endOffset - 1, 0))]
      return Array.from({ length: to - from + 1 }, (_, k) => (vertical
        ? { left: (from + k) * 20, top: 0, width: 14, height: 300 }
        : { top: (from + k) * 20, left: 0, height: 14, width: 300 }))
    }
    const at = (sel: string, o: number) => {
      const r = document.createRange()
      const t = document.querySelector(sel)!.firstChild!
      r.setStart(t, o)
      r.setEnd(t, o + 5)
      return r
    }
    const top = (place: Range, mark: Range, scrolled: boolean) => atTop(place, mark, { scrolled, rects: rects() })

    it('lineCount_RectsOnOneLineCountOnce_ByTheBlockAxis', () => {
      expect(lineCount([])).toBe(0)
      // Two fragments of one line (a taller one starting a little higher), then two more lines.
      expect(lineCount([{ top: 100, left: 0, width: 50, height: 14 }, { top: 97, left: 50, width: 20, height: 20 }, { top: 120, left: 0, width: 80, height: 14 }, { top: 140, left: 0, width: 80, height: 14 }])).toBe(3)
      // A box with no size along the block axis is no line.
      expect(lineCount([{ top: 100, left: 0, width: 50, height: 0 }])).toBe(0)
      // A vertical book: lines run across the page.
      expect(lineCount([{ top: 0, left: 100, width: 14, height: 80 }, { top: 80, left: 100, width: 14, height: 40 }, { top: 0, left: 80, width: 14, height: 80 }], true)).toBe(2)
      expect(lineCount([{ top: 0, left: 100, width: 14, height: 80 }, { top: 80, left: 100, width: 14, height: 40 }, { top: 0, left: 80, width: 14, height: 80 }])).toBe(2)
    })

    it('atTop_StartsWhereTheScreenDoes_BothFlows', () => {
      document.body.innerHTML = HTML
      for (const scrolled of [false, true]) expect(top(at('#b', 0), at('#b', 0), scrolled)).toBe(true)
    })

    it('atTop_LaterOnTheScreensFirstLine_Yes_ALineFurtherDown_No_BothFlows', () => {
      document.body.innerHTML = HTML
      for (const scrolled of [false, true]) {
        expect(top(at('#b', 0), at('#b', 30), scrolled)).toBe(true)
        expect(top(at('#b', 0), at('#b', 40), scrolled)).toBe(false)
        expect(top(at('#b', 0), at('#c', 0), scrolled)).toBe(false)
      }
    })

    it('atTop_AboveTheScreensFirstLine_ScrolledUpToTwoLines_PaginatedNever', () => {
      document.body.innerHTML = HTML
      // The screen's first whole line is #b's second (offset 40): one above, two above (another block), three above.
      const place = at('#b', 40)
      expect(top(place, at('#b', 0), true)).toBe(true)
      expect(top(place, at('#a', 80), true)).toBe(true)
      expect(top(place, at('#a', 79), true)).toBe(false)
      // Paginated: what is before the screen's start is the page before.
      expect(top(place, at('#b', 39), false)).toBe(false)
      expect(top(place, at('#b', 0), false)).toBe(false)
    })

    it('atTop_AVerticalBook_LinesCountedAcrossThePage', () => {
      document.body.innerHTML = HTML
      const opts = { scrolled: true, vertical: true, rects: rects(true) }
      expect(atTop(at('#b', 40), at('#b', 0), opts)).toBe(true)
      expect(atTop(at('#b', 40), at('#a', 79), opts)).toBe(false)
      // The same rects read as a horizontal book are all one line: the axis matters.
      expect(atTop(at('#b', 40), at('#a', 79), { ...opts, vertical: false })).toBe(true)
    })

    it('atTop_NoLayoutOrAnotherDocument_No', () => {
      document.body.innerHTML = HTML
      // Nothing laid out (no rects), or a DOM that cannot say (jsdom has no Range rects: it throws): nothing but the
      // same start is at the top.
      expect(atTop(at('#b', 0), at('#b', 5), { rects: () => [] })).toBe(false)
      expect(atTop(at('#b', 0), at('#b', 5))).toBe(false)
      expect(atTop(at('#b', 0), at('#b', 0))).toBe(true)
      const other = new DOMParser().parseFromString('<p>One two three.</p>', 'text/html')
      const r = other.createRange()
      r.selectNodeContents(other.body)
      expect(atTop(at('#b', 0), r, { scrolled: true, rects: rects() })).toBe(false)
    })
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
    const m = { type: 'bookmark-list', key: 'abc', bookmarks: [{ id: 'b1', cfi: CFI, text: 'First words', at: 5, extra: 1 }], here: 'b1', can: true, placing: true }
    expect(readBookmarkList(m)).toEqual({ key: 'abc', bookmarks: [{ id: 'b1', cfi: CFI, text: 'First words', at: 5 }], here: 'b1', can: true, placing: true })
  })

  it('readBookmarkList_MalformedItemsDropped_HereOnlyIfListed_CanOnlyIfTrue', () => {
    const ok = { id: 'b1', cfi: CFI, text: 't', at: 'soon' }
    const m = {
      type: 'bookmark-list', key: 'abc', here: 'b9', can: 'yes', placing: 1,
      bookmarks: [ok, null, { ...ok, id: '<img>' }, { ...ok, id: 'b2', cfi: 'javascript:1' }, { ...ok, id: 'b3', text: 5 }, { ...ok, id: 'b4', text: 'x'.repeat(401) }],
    }
    // `can` and `placing` only when strictly true.
    expect(readBookmarkList(m)).toEqual({ key: 'abc', bookmarks: [{ id: 'b1', cfi: CFI, text: 't', at: null }], here: null, can: false, placing: false })
    // `here` naming a dropped item is none.
    expect(readBookmarkList({ ...m, here: 'b2' })!.here).toBeNull()
  })

  it('readBookmarkList_NotABookmarkList_Null', () => {
    const m = { type: 'bookmark-list', key: 'abc', bookmarks: [], here: null, can: false }
    expect(readBookmarkList(m)).toEqual({ key: 'abc', bookmarks: [], here: null, can: false, placing: false })
    for (const bad of [null, 'x', { ...m, type: 'highlight-list' }, { ...m, key: 5 }, { ...m, bookmarks: {} }]) expect(readBookmarkList(bad)).toBeNull()
  })
})
