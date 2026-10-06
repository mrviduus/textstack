// @vitest-environment jsdom
/**
 * Theme across a chapter change. ‹ / › change the route, which remounts the reader: a new
 * useReaderSettings (defaults until AsyncStorage answers) and a new useReaderDocument. The new
 * chapter was built Light and the Dark injection went into a document still loading — lost, while
 * the RN header and footer (plain React state) were Dark.
 */
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '../../test/renderHook'
import { useReaderDocument } from './useReaderDocument'
import { useReaderSettings, themeStyles } from '../../hooks/useReaderSettings'

vi.mock('../../lib/api', () => ({ API_URL: 'https://api.test' }))
vi.mock('../../lib/readerHtml', () => ({
  buildReaderHtml: (html: string, t: { backgroundColor: string }) => `<doc bg=${t.backgroundColor}>${html}`,
  buildPdfViewerHtml: () => '<pdf>',
}))

const LIGHT = themeStyles.light
const DARK = themeStyles.dark
const noop = () => {}

function mountDocument(slug: string, theme: { backgroundColor: string; textColor: string }) {
  const injected: string[] = []
  const ref = <T,>(v: T) => ({ current: v })
  const h = renderHook((p: { slug: string; theme: typeof theme }) => useReaderDocument({
    original: false, originalFileUrl: null, originalInitialPage: null, htmlChapterSlug: p.slug,
    injectJs: (js: string) => injected.push(js), reflow: noop as never, onDocumentRebuild: noop,
    chapter: { html: `<p>${p.slug}</p>` },
    settings: { fontSize: 18, lineHeight: 1.6, textAlign: 'left' } as never,
    resolvedFontFamily: 'serif', resolvedTheme: p.theme as never,
    insets: { top: 0, bottom: 0, left: 0, right: 0 },
    pdfToken: null, pdfTokenReady: false, pdfReloadNonce: 0, isLocalOriginal: false,
    pdfInitialPageRef: ref(null), currentPdfPageRef: ref(null), pdfIsReloadRef: ref(false), pdfReadyRef: ref(false),
  }), { slug, theme })
  // ReaderShell's reflow onLoadEnd, the document half.
  const loadEnd = () => act(() => {
    h.result.current.docLoadedRef.current = true
    h.result.current.applyTypography()
    h.result.current.applyChrome()
  })
  /** The background the document shows: what it was built with, then every injection that reached it. */
  const shownBg = (loadedAt: number) => {
    let bg = (h.result.current.webViewSource as { html: string }).html.match(/bg=(\S+?)>/)![1]
    for (const js of injected.slice(loadedAt)) {
      const m = js.match(/b\.style\.background="([^"]+)"/)
      if (m) bg = m[1]
    }
    return bg
  }
  return { h, injected, loadEnd, shownBg }
}

describe('reader theme across a chapter change', () => {
  it('a theme that arrives while the new chapter loads is applied once it has loaded', () => {
    // The previous chapter, switched to Dark.
    const a = mountDocument('ch-1', LIGHT)
    a.loadEnd()
    a.h.rerender({ theme: DARK })
    expect(a.shownBg(0)).toBe(DARK.backgroundColor)
    a.h.unmount()

    // › : a new mount. Settings are still loading, so the document is built Light...
    const b = mountDocument('ch-2', LIGHT)
    // ...and Dark arrives before its onLoadEnd: an injection now would land in no document.
    b.h.rerender({ theme: DARK })
    const loadedAt = b.injected.length
    b.loadEnd()
    expect(b.shownBg(loadedAt)).toBe(DARK.backgroundColor)
    b.h.unmount()
  })

  it('the next chapter reads the settings the reader already has, not the defaults', async () => {
    const first = renderHook(() => useReaderSettings(), {})
    await act(async () => {})
    act(() => first.result.current.update({ theme: 'dark', fontFamily: 'sans' }))
    first.unmount()

    const next = renderHook(() => useReaderSettings(), {})
    // The first render — the one that builds the next chapter's document.
    expect(next.result.current.settings.theme).toBe('dark')
    expect(next.result.current.settings.fontFamily).toBe('sans')
    next.unmount()
  })
})
