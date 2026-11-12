// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { openableHref, sentenceOf, sentenceOfRange } from './tap.mjs'

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
