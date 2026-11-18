// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import web from '../../shared/src/reader/__fixtures__/anchors/web.json'
import mobile from '../../shared/src/reader/__fixtures__/anchors/mobile.json'
import { ANCHOR_CASES, caseStart, chapterById } from '../../shared/src/reader/__fixtures__/anchors/chapters'
import { chapterText, quoteAt, rangeToLocator, rangesIn, sentenceAround } from './text'

const root = (html: string) => {
  const el = document.createElement('article')
  el.innerHTML = html
  return el
}
type Fixture = Record<string, { prefix?: string; exact: string; suffix?: string; startOffset?: number }>

describe('a section as text', () => {
  it("is its text nodes in order, without script, style, noscript or the apps' gloss nodes", () => {
    const el = root('<p>the <mark>garden<span class="vocab-inline-translation">сад</span></mark> wall</p><div data-vocab-overlay="true">gloss</div><style>p{}</style><script>x()</script><noscript><p>no</p></noscript>')
    expect(chapterText(el)).toBe('the garden wall')
    expect(rangeToLocator(el, rangesIn(el)(4, 6)!, 's')!.text).toEqual({ before: 'the ', highlight: 'garden', after: ' wall' })
  })
})

describe('a highlight quotes its selection as every stored anchor does', () => {
  for (const c of ANCHOR_CASES) {
    it(`${c.name}: same quote and offset as the frozen web and mobile anchors`, () => {
      const el = root(chapterById(c.chapter).html)
      const html = el.innerHTML
      const loc = rangeToLocator(el, rangesIn(el)(caseStart(chapterText(el), c), c.exact.length)!, 'slug')!
      const w = (web as Fixture)[c.name]
      const m = (mobile as Fixture)[c.name]
      expect(loc.text).toEqual({ before: w.prefix, highlight: w.exact, after: w.suffix })
      expect(loc.text).toEqual({ before: m.prefix, highlight: m.exact, after: m.suffix })
      expect(loc.locations.charOffset).toBe(w.startOffset)
      expect(el.innerHTML, 'text nodes untouched').toBe(html)
    })
  }

  // The server refuses a lone surrogate (no UTF-8 form): the context never cuts a pair in half.
  it('its context never splits a surrogate pair', () => {
    const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
    const text = '😀'.repeat(40) + 'word' + '😀'.repeat(40)   // 30 units back from 81, and on from 83, land mid-pair
    const quote = quoteAt(text, 81, 83).text
    expect(quote.highlight).toBe('or')
    expect(quote.before).not.toMatch(lone)
    expect(quote.after).not.toMatch(lone)
  })
})

// E48: the sentence a selection carries is the one TR-1 pins for both apps (the shared fixture).
type Case = { name: string; text: string; html?: string; tag?: string; offset: number; word: string; expected: string }
const cases: Case[] = JSON.parse(readFileSync(resolve(__dirname, '../../shared/src/text/__fixtures__/sentences.json'), 'utf8'))

describe('the sentence around a word', () => {
  it.each(cases.filter((c) => !c.html && !c.tag))('TR-1 shared fixture: $name', (c) => {
    expect(sentenceAround(c.text, 0, c.text.length, c.offset, c.offset + c.word.length)).toBe(c.expected)
  })
})
