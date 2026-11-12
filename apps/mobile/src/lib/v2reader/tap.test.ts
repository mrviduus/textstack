// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { openableHref, rectInPage, sentenceOf, sentenceOfRange, trimRange } from './tap.mjs'

/** Taps the first `word` the way page.mjs does: a text node and the word's offsets in it. XHTML when `mime` says so. */
function tap(html: string, word: string, mime?: DOMParserSupportedType): string {
  let doc: Document = document
  if (mime) doc = new DOMParser().parseFromString(html, mime)
  else document.body.innerHTML = html
  const walker = doc.createTreeWalker(doc.body ?? doc.documentElement, NodeFilter.SHOW_TEXT)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const i = node.data.indexOf(word)
    if (i >= 0 && !node.parentElement?.closest('style')) return sentenceOf(node, i, i + word.length)
  }
  throw new Error(`"${word}" not in the page`)
}

const xhtml = (body: string) => `<html xmlns="http://www.w3.org/1999/xhtml"><body>${body}</body></html>`

describe('v2 reader tap', () => {
  it.each([
    ['newline', '<p>Before. The quick\nbrown fox. Next one.</p>', 'brown', 'The quick brown fox.'],
    ['crlf', '<p>Before. The quick\r\nbrown fox. Next.</p>', 'brown', 'The quick brown fox.'],
    ['tab', '<p>Before. The\tquick brown. Next.</p>', 'quick', 'The quick brown.'],
    ['nbsp', '<p>Before. Mr Smith came. Next.</p>', 'Smith', 'Mr Smith came.'],
    ['ideographic space', '<p>A.　Next word here.</p>', 'word', 'Next word here.'],
    ['line separator', '<p>A. Next word here.</p>', 'word', 'Next word here.'],
    ['emoji before the word', '<p>Smile \u{1F600} then\nrun fast. Ok.</p>', 'run', 'Smile \u{1F600} then run fast.'],
    ['word at block start', '<p>Hello brave world. Bye.</p>', 'Hello', 'Hello brave world.'],
    ['word at block end', '<p>Hello brave world</p>', 'world', 'Hello brave world'],
    ['word ending its node', '<p>First. <em>Second</em> word here. Third.</p>', 'Second', 'Second word here.'],
    ['sentence crossing a span', '<p>Before. One <span>two three</span> four. After.</p>', 'three', 'One two three four.'],
    ['style inside the block', '<p>Before. <style>.x { color: red }</style>Styled word here. After.</p>', 'word', 'Styled word here.'],
    ['div paragraph with a span', '<div class="para">One <span>two three</span> four.</div>', 'three', 'One two three four.'],
    // S5 review: a PDF text layer (pdf.js) separates its lines with <br> only; a line end is a space.
    ['pdf text layer, word before the line end', '<div class="textLayer"><span>Sphinx of black quartz judges</span><br><span>my vow and the fox.</span></div>', 'judges', 'Sphinx of black quartz judges my vow and the fox.'],
    ['pdf text layer, word after the line end', '<div class="textLayer"><span>Sphinx of black quartz judges</span><br><span>my vow and the fox.</span></div>', 'vow', 'Sphinx of black quartz judges my vow and the fox.'],
    ['br inside a paragraph', '<p>Before. One<br>two three. Next.</p>', 'two', 'One two three.'],
  ])('sentenceOf_%s_OffsetsHold', (_, html, word, sentence) => {
    expect(tap(html, word)).toBe(sentence)
  })

  it('sentenceOf_XhtmlSectionWithLowerCaseTags_SpanIsInlineToo', () => {
    expect(tap(xhtml('<div>One <span>two three</span> four.</div>'), 'three', 'application/xhtml+xml')).toBe('One two three four.')
  })

  /** Selects from the first `from` to the end of the first `to` after it, as a drag does, and reads its sentence. */
  function select(html: string, from: string, to: string): string {
    document.body.innerHTML = html
    const nodes: Text[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) nodes.push(walker.currentNode as Text)
    const a = nodes.find((n) => n.data.includes(from))!
    const b = nodes.slice(nodes.indexOf(a)).find((n) => n.data.includes(to))!
    const end = b === a ? b.data.indexOf(to, a.data.indexOf(from)) : b.data.indexOf(to)
    return sentenceOfRange(a, a.data.indexOf(from), b, end + to.length)
  }

  it.each([
    ['inside one node', '<p>Before. The quick brown fox. After.</p>', 'quick', 'fox', 'The quick brown fox.'],
    ['across a span', '<p>Before. One <em>two three</em> four five. After.</p>', 'One', 'three', 'One two three four five.'],
    ['across two sentences', '<p>Before. One two. Three four. After.</p>', 'two', 'Three', 'One two. Three four.'],
    ['across a br', '<p>Before. One<br>two three. Next.</p>', 'One', 'two', 'One two three.'],
    ['into the next block: the start block only', '<p>Before. One two</p><p>three four.</p>', 'two', 'three', 'One two'],
  ])('sentenceOfRange_%s_SentenceAroundTheSelection', (_, html, from, to, sentence) => {
    expect(select(html, from, to)).toBe(sentence)
  })

  it('sentenceOfRange_ElementBoundaries_MappedToText', () => {
    document.body.innerHTML = '<p>Before. <em>One two</em> three. After.</p>'
    const em = document.querySelector('em')!
    expect(sentenceOfRange(em, 0, em, 1)).toBe('One two three.')
  })

  it('sentenceOfRange_BlockElementPoint_ThatBlockNotItsParent', () => {
    document.body.innerHTML = '<div><p>Alpha beta</p><p>Gamma delta.</p></div>'
    const p = document.querySelectorAll('p')[1]
    expect(sentenceOfRange(p, 0, p, 1)).toBe('Gamma delta.')
  })

  it.each([
    ['html', () => document.documentElement],
    ['the document', () => document as unknown as Node],
  ])('sentenceOfRange_PointOn%s_WholeBodyNeverThrows', (_, node) => {
    document.head.innerHTML = '<title>Title</title>'
    document.body.innerHTML = '<p>One two.</p>'
    expect(sentenceOfRange(node(), 0, node(), 1)).toBe('One two.')
  })

  /** A range from (text of `a`, offset `ao`) to (text of `b`, offset `bo`). */
  const rangeOf = (a: Element, ao: number, b: Element, bo: number) => {
    const r = document.createRange()
    r.setStart(a.firstChild!, ao)
    r.setEnd(b.firstChild!, bo)
    return r
  }

  it('trimRange_DragFromTheBlankAfterAHeading_StartsInTheParagraph', () => {
    document.body.innerHTML = '<h1>Chapter One </h1>\n<p>Paragraph 1. Sphinx of black quartz.</p>'
    const [h1, p] = [document.querySelector('h1')!, document.querySelector('p')!]
    const raw = rangeOf(h1, 'Chapter One'.length, p, 'Paragraph 1.'.length)
    const r = trimRange(raw)!
    expect(r.toString()).toBe('Paragraph 1.')
    expect(sentenceOfRange(r.startContainer, r.startOffset, r.endContainer, r.endOffset)).toBe('Paragraph 1.')
    expect(sentenceOfRange(raw.startContainer, raw.startOffset, raw.endContainer, raw.endOffset)).toBe('Chapter One')
  })

  it('trimRange_EdgeWhitespace_FromTheFirstToTheLastLetter', () => {
    document.body.innerHTML = '<p>One  two </p><p> </p>'
    const ps = document.querySelectorAll('p')
    expect(trimRange(rangeOf(ps[0], 3, ps[1], 1))!.toString()).toBe('two')
  })

  it('trimRange_WhitespaceOnly_Null', () => {
    document.body.innerHTML = '<p>One </p><p> two</p>'
    const ps = document.querySelectorAll('p')
    expect(trimRange(rangeOf(ps[0], 3, ps[1], 1))).toBeNull()
  })

  const frame = (left: number, top: number, width: number, offsetWidth: number, clientLeft = 0) =>
    ({ getBoundingClientRect: () => ({ left, top, width }), offsetWidth, clientLeft, clientTop: clientLeft }) as unknown as HTMLIFrameElement

  it.each([
    ['unscaled', frame(-300.4, 10, 600, 600), { x: 20, y: 51, w: 81, h: 19 }],
    ['scaled 0.9 (a pre-paginated page)', frame(700, 10, 540, 600), { x: 988, y: 47, w: 72, h: 17 }],
    ['scaled, with a border', frame(700, 10, 540, 600, 2), { x: 990, y: 48, w: 72, h: 17 }],
    ['not laid out', frame(5, 5, 0, 0), { x: 325, y: 46, w: 81, h: 19 }],
    ['laid out 0 wide, drawn wide', frame(5, 5, 540, 0), { x: 325, y: 46, w: 81, h: 19 }],
  ])('rectInPage_%s_PageViewportBox', (_, f, want) => {
    expect(rectInPage(f, { left: 320.2, top: 40.6, width: 80.5, height: 19.4 } as DOMRect)).toEqual(want)
  })

  it('rectInPage_UntransformedFractionalWidthDeepInAChapter_NoDrift', () => {
    // offsetWidth rounds 600.4 to 600: read as a scale, 3000 px down would drift 2 px.
    expect(rectInPage(frame(0, -2990, 600.4, 600), { left: 10, top: 3000, width: 30, height: 20 } as DOMRect)).toEqual({ x: 10, y: 10, w: 30, h: 20 })
  })

  it.each([
    ['https link', '<a href="https://example.org/x">x</a>', 'https://example.org/x'],
    ['http link', '<a href="http://example.org/">x</a>', 'http://example.org/'],
    ['javascript: link', '<a href="javascript:alert(1)">x</a>', null],
    ['intent: link', '<a href="intent://x#Intent;end">x</a>', null],
    ['file: link', '<a href="file:///data/user/0/x">x</a>', null],
    ['SVG link', '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.org/svg"><text>x</text></a></svg>', 'https://example.org/svg'],
    ['SVG javascript: link', '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><text>x</text></a></svg>', null],
  ])('openableHref_%s_OnlyHttpOrHttps', (_, html, want) => {
    document.body.innerHTML = html
    expect(openableHref(document.querySelector('a')!)).toBe(want)
  })
})
