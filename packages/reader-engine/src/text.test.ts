// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import web from '../../shared/src/reader/__fixtures__/anchors/web.json'
import mobile from '../../shared/src/reader/__fixtures__/anchors/mobile.json'
import mcp from '../../shared/src/reader/__fixtures__/anchors/mcp.json'
import { ANCHOR_CASES, PRODUCER_ONLY_CASES, caseStart, chapterById } from '../../shared/src/reader/__fixtures__/anchors/chapters'
import { anchorToLocator } from './mappers'
import { resolveLocator } from './resolve'
import { chapterText, positionAt, rangeAt, rangeToLocator } from './text'

/**
 * The chapter as text (ADR-025 Phase 2, slice 2): the DOM half of anchoring. Offsets count the
 * chapter's text nodes the way web `createTextAnchor` and the phone's `getSelectionAnchor` do, so the
 * frozen cross-app fixtures land on the same characters. Rule ids (T1…) are in the test names.
 */

const root = (html: string) => {
  const el = document.createElement('article')
  el.innerHTML = html
  return el
}
type Fixture = Record<string, { prefix?: string; exact: string; suffix?: string; startOffset?: number }>

describe('chapterText', () => {
  it('T1 is the text nodes in order, without script / style / noscript', () => {
    const el = root('<p>One <em>two</em></p><style>p{}</style><script>x()</script><noscript><p>no</p></noscript><p>three</p>')
    expect(chapterText(el)).toBe('One twothree')
  })

  it("T1 skips the apps' gloss nodes, as web createTextAnchor and the phone's chapterText do", () => {
    const el = root('<p>the <mark>garden<span class="vocab-inline-translation">сад</span></mark> wall</p><div data-vocab-overlay="true">gloss</div>')
    expect(chapterText(el)).toBe('the garden wall')
    const loc = rangeToLocator(el, rangeAt(el, 4, 6)!, 's')!
    expect(loc.text).toEqual({ before: 'the ', highlight: 'garden', after: ' wall' })
  })
})

describe('rangeToLocator: a selection becomes a TextQuoteSelector', () => {
  for (const c of ANCHOR_CASES) {
    it(`T2 ${c.name}: same quote and offset as web createTextAnchor and mobile getSelectionAnchor`, () => {
      const el = root(chapterById(c.chapter).html)
      const html = el.innerHTML
      const start = caseStart(chapterText(el), c)
      const loc = rangeToLocator(el, rangeAt(el, start, c.exact.length)!, 'slug')!
      const w = (web as Fixture)[c.name]
      const m = (mobile as Fixture)[c.name]
      expect(loc.text).toEqual({ before: w.prefix, highlight: w.exact, after: w.suffix })
      expect(loc.text).toEqual({ before: m.prefix, highlight: m.exact, after: m.suffix })
      expect(loc.locations.charOffset).toBe(w.startOffset)
      expect(loc).toMatchObject({ href: 'slug', type: 'text/html' })
      expect(el.innerHTML, 'text nodes untouched').toBe(html)
    })
  }
})

describe('rangeAt: an offset back to a Range', () => {
  // Every producer's frozen anchor: the ladder finds the offset, the Range covers the passage.
  for (const [producer, file] of [['web', web], ['mobile', mobile], ['mcp', mcp]] as const) {
    for (const [name, anchor] of Object.entries(file as Fixture)) {
      it(`T3 ${producer}/${name}`, () => {
        const c = ANCHOR_CASES.find((x) => x.name === name)
        const el = root(chapterById(c?.chapter ?? ANCHOR_CASES[0].chapter).html)
        const r = resolveLocator(anchorToLocator(JSON.stringify(anchor), 's'), 's', chapterText(el))
        expect(r && 'offset' in r).toBe(true)
        if (!r || !('offset' in r)) return
        expect(rangeAt(el, r.offset, anchor.exact.length)?.toString()).toBe(c?.exact ?? PRODUCER_ONLY_CASES[name])
      })
    }
  }

  it('T3 out of the text: null, never a clipped range', () => {
    const el = root('<p>short</p>')
    expect(rangeAt(el, 3, 10)).toBeNull()
    expect(rangeAt(el, -1, 2)).toBeNull()
  })

  it('T2 a range outside the chapter is no locator', () => {
    const other = root('<p>elsewhere</p>')
    expect(rangeToLocator(root('<p>short</p>'), rangeAt(other, 0, 4)!, 's')).toBeNull()
  })

  it('T2 a collapsed range (a tap) is no locator: an empty quote never resolves', () => {
    const el = root('<p>short</p>')
    expect(rangeToLocator(el, rangeAt(el, 2, 0)!, 's')).toBeNull()
  })
})

describe('positionAt: the reading line as a position locator', () => {
  const html = '<p>It was a bright cold day in April, and the clocks were striking thirteen.</p>' +
    '<p>Winston Smith, his chin nuzzled into his breast in an effort to escape the vile wind, slipped quickly.</p>'

  it('T4 quotes 64 characters with 30 of context, offset from the caret node, and resolves back exactly', () => {
    const el = root(html)
    const second = el.querySelectorAll('p')[1].firstChild!
    const loc = positionAt(el, second, 15, 'c1', 0.4)!
    const text = chapterText(el)
    const at = text.indexOf('his chin')
    expect(loc.locations).toEqual({ charOffset: at, progression: 0.4 })
    expect(loc.text).toEqual({ before: text.slice(at - 30, at), highlight: text.slice(at, at + 64), after: text.slice(at + 64, at + 94) })
    expect(resolveLocator(loc, 'c1', text)).toEqual({ result: 'exact', offset: at })
  })

  it('T4 a caret on an element counts the text before its child', () => {
    const el = root(html)
    const loc = positionAt(el, el, 1, 'c1', 0)!
    expect(loc.locations.charOffset).toBe(el.querySelector('p')!.textContent!.length)
  })

  it('T4 nothing left to quote at the very end, or a caret outside the chapter: null', () => {
    const el = root(html)
    expect(positionAt(el, el, el.childNodes.length, 'c1', 1)).toBeNull()
    expect(positionAt(el, document.createTextNode('elsewhere'), 0, 'c1', 0)).toBeNull()
  })

  it('T4 a stale caret past the node end: null, never a throw', () => {
    const el = root(html)
    const first = el.querySelector('p')!.firstChild as Text
    expect(positionAt(el, first, first.length + 5, 'c1', 0)).toBeNull()
    expect(positionAt(el, el, el.childNodes.length + 1, 'c1', 0)).toBeNull()
  })
})
