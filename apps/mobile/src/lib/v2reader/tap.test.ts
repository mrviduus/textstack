// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { openableHref, sentenceOf } from './tap.mjs'

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
  ])('sentenceOf_%s_OffsetsHold', (_, html, word, sentence) => {
    expect(tap(html, word)).toBe(sentence)
  })

  it('sentenceOf_XhtmlSectionWithLowerCaseTags_SpanIsInlineToo', () => {
    expect(tap(xhtml('<div>One <span>two three</span> four.</div>'), 'three', 'application/xhtml+xml')).toBe('One two three four.')
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
