// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { clipBook, clipDocument } from './clip.mjs'

const bytes = (s: string) => new TextEncoder().encode(s)

describe('HTML clips', () => {
  it('aClippedArticle_OpensAsOneSectionBookWithItsText_ScriptsAndHandlersGone', () => {
    const article = '﻿<div id="readability-page-1"><h1>On walking</h1><p onclick="x()">Café <a href="https://e.tst/p">source</a> '
      + '<a href="java\tscript:alert(1)">trap</a></p><script>alert(1)</script><img src="https://e.tst/a.png" alt="A chart" onerror="alert(2)">'
      + '<img src="data:image/png;base64,AA"><iframe src="https://e.tst"></iframe><svg onload="alert(3)"><circle r="1"/></svg>'
      + '<form action="https://e.tst"><input name="p"></form><custom-el>kept text</custom-el></div>'
    const { html, title } = clipDocument(bytes(article))
    expect(title).toBe('On walking')
    expect(html).toBe('<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><div id="readability-page-1"><h1>On walking</h1>'
      + '<p>Café <a href="https://e.tst/p">source</a> <a>trap</a></p>A chart<img src="data:image/png;base64,AA">kept text</div></body></html>')
    const book = clipBook(bytes(article))
    expect(book.sections).toHaveLength(1)
    expect(book.sections[0].createDocument().body.textContent).toContain('Café source trap')
  })

  it('aCraftedClip_CannotHangTheReader', () => {
    // Thousands of children unwrapped (a loop, never a spread) and deep nesting: sanitized in bounded time.
    const crafted = `<custom-el>${'<b>x</b>'.repeat(3000)}</custom-el>${'<span>'.repeat(1000)}deep${'</span>'.repeat(1000)}`
    const t0 = performance.now()
    const { html } = clipDocument(bytes(crafted))
    expect(html).toContain('deep')
    expect(performance.now() - t0).toBeLessThan(5000)
  })
})
