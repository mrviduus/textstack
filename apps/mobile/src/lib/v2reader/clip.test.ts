// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { clipDocument, clipText, sanitizeClip } from './clip.mjs'

const clean = (html: string) => sanitizeClip(new DOMParser().parseFromString(html, 'text/html').body).innerHTML
const bytes = (s: string) => new TextEncoder().encode(s)

describe('sanitizeClip', () => {
  it('script_RemovedWithItsText', () => {
    expect(clean('<p>a</p><script>alert(1)</script><p>b</p>')).toBe('<p>a</p><p>b</p>')
  })

  it('eventHandlerAttributes_Removed', () => {
    expect(clean('<img src="data:image/png;base64,AA" onerror="alert(1)"><p onclick="x()" style="color:red">t</p>'))
      .toBe('<img src="data:image/png;base64,AA"><p>t</p>')
  })

  it('javascriptHref_Removed_SafeLinksKept', () => {
    expect(clean('<a href="javascript:alert(1)">x</a><a href=" javascript:alert(1)">y</a><a href="java&#9;script:alert(1)">z</a>'))
      .toBe('<a>x</a><a>y</a><a>z</a>')
    expect(clean('<a href="https://e.tst/p">o</a><a href="#n">i</a>')).toBe('<a href="https://e.tst/p">o</a><a href="#n">i</a>')
  })

  it('svgWithOnload_RemovedWhole', () => {
    expect(clean('<svg onload="alert(1)"><circle r="1"/><script>alert(2)</script></svg><p>t</p>')).toBe('<p>t</p>')
  })

  it('iframeObjectEmbedForm_Removed', () => {
    expect(clean('<iframe src="https://e.tst"></iframe><object data="x"></object><embed src="x"><form action="https://e.tst"><input name="p"><button>go</button></form><p>t</p>'))
      .toBe('<p>t</p>')
  })

  it('unknownElements_UnwrappedTextKept_CommentsRemoved', () => {
    expect(clean('<custom-el onclick="x()"><font color="red">kept</font></custom-el><!-- c -->')).toBe('kept')
  })

  it('mathAndNoscriptAndStyle_Removed', () => {
    expect(clean('<math><mi>x</mi></math><noscript><p>n</p></noscript><style>p{}</style><p>t</p>')).toBe('<p>t</p>')
  })

  it('dataImageSrcKept_AnyOtherImageBecomesItsAltText', () => {
    // Review #1362: the page's CSP is `img-src blob: data:`, so an https image would only ever be broken.
    expect(clean('<p><img src="data:image/png;base64,AA" alt="d"><img src="https://x.tst/a.png" alt="A chart"><img src="javascript:x"><img></p>'))
      .toBe('<p><img src="data:image/png;base64,AA" alt="d">A chart</p>')
  })

  it('manyChildrenUnwrapped_NoStackOverflow', () => {
    // Review #1362: unwrapped by a loop, not a spread. jsdom moves nodes in O(n) each, so 3k here (the loop's behaviour); a spread fails past ~120k.
    const doc = new DOMParser().parseFromString('<custom-el></custom-el>', 'text/html')
    const el = doc.body.firstElementChild!
    for (let i = 0; i < 3_000; i++) el.appendChild(doc.createTextNode('x'))
    expect(sanitizeClip(doc.body).textContent).toHaveLength(3_000)
  })
})

describe('clipDocument', () => {
  it('fragment_AWholeDocumentWithCharsetAndTheBodySanitized', () => {
    const d = clipDocument(bytes('<div id="readability-page-1"><h1>Title  here</h1><p>Text — ✓</p><script>x()</script></div>'))
    expect(d.title).toBe('Title here')
    expect(d.html).toMatch(/^<!DOCTYPE html><html><head><meta charset="utf-8"><\/head><body><div id="readability-page-1"><h1>Title {2}here<\/h1><p>Text — ✓<\/p><\/div><\/body><\/html>$/)
  })

  it('wholePage_TitleAndLangKept_HeadDropped', () => {
    const d = clipDocument(bytes('<!doctype html><html lang="uk"><head><title>T</title><meta http-equiv="refresh" content="0;url=https://e.tst"><base href="https://e.tst/"></head><body><p>x</p></body></html>'))
    expect(d).toMatchObject({ title: 'T', lang: 'uk' })
    expect(d.html).toBe('<!DOCTYPE html><html lang="uk"><head><meta charset="utf-8"></head><body><p>x</p></body></html>')
  })

  it('clipText_BomThenMetaCharsetThenUtf8', () => {
    const latin1 = new Uint8Array([...new TextEncoder().encode('<meta charset="windows-1252"><p>caf'), 0xe9, ...new TextEncoder().encode('</p>')])
    expect(clipText(latin1)).toContain('café')
    expect(clipText(new Uint8Array([0xff, 0xfe, ...Array.from('<p>é', (c) => [c.charCodeAt(0), 0]).flat()]))).toBe('<p>é')
    expect(clipText(bytes('<meta charset="no-such"><p>é</p>'))).toContain('<p>é</p>')
  })

  it('hostileLang_NotCopied', () => {
    expect(clipDocument(bytes('<html lang=\'x" onload="y\'><body><p>x</p></body></html>')).html).toContain('<html><head>')
  })
})
