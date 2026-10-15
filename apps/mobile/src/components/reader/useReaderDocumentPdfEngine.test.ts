// @vitest-environment jsdom
/**
 * The Original-layout PDF document is the engine page: streamed from the API origin, or a downloaded
 * file beside a file:// base (the
 * reading path needs no network and no token for it).
 */
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '../../test/renderHook'
import { useReaderDocument } from './useReaderDocument'

const built: { url: string; token: string | null; local: boolean }[] = []
vi.mock('../../lib/api', () => ({ API_URL: 'https://api.test' }))
vi.mock('../../lib/readerHtml', () => ({
  buildEngineReaderHtml: () => '<doc>',
  buildPdfEngineHtml: (url: string, token: string | null, o: { local: boolean }) => { built.push({ url, token, local: o.local }); return '<pdf engine>' },
}))

function mount(fileUrl: string, token: string | null, ready = true) {
  const ref = <T,>(v: T) => ({ current: v })
  return renderHook((p: { token: string | null; ready: boolean }) => useReaderDocument({
    original: true, originalFileUrl: fileUrl, originalInitialPage: 3, htmlChapterSlug: 'one',
    injectJs: () => {}, reflow: (() => {}) as never, onDocumentRebuild: () => {},
    chapter: { html: '' },
    settings: { fontSize: 18, lineHeight: 1.6, textAlign: 'left' } as never,
    resolvedFontFamily: 'serif', resolvedTheme: { backgroundColor: '#fff', textColor: '#000' } as never,
    insets: { top: 24, bottom: 0, left: 0, right: 0 },
    pdfToken: p.token, pdfTokenReady: p.ready, isLocalOriginal: fileUrl.startsWith('file://'),
    pdfInitialPageRef: ref(null), currentPdfPageRef: ref(null), pdfIsReloadRef: ref(false), pdfReadyRef: ref(false),
  }), { token, ready })
}

describe('useReaderDocument — engine PDF page', () => {
  it('streamed: the engine page on the API origin, with the token', () => {
    const h = mount('https://api.test/me/books/b1/file', 'tok')
    expect(h.result.current.webViewSource).toEqual({ html: '<pdf engine>', baseUrl: 'https://api.test' })
    expect(built.at(-1)).toEqual({ url: 'https://api.test/me/books/b1/file', token: 'tok', local: false })
  })

  it('downloaded: the bare file name beside a file:// base, no token, read off the disk', () => {
    const h = mount('file:///data/originals/b1.pdf', null)
    expect(h.result.current.webViewSource).toEqual({ html: '<pdf engine>', baseUrl: 'file:///data/originals/' })
    expect(built.at(-1)).toEqual({ url: 'b1.pdf', token: null, local: true })
  })

  it('a refreshed token does not rebuild the document (it reaches the page over the bridge); a remount after a dead renderer opens with it', () => {
    const h = mount('https://api.test/me/books/b1/file', 'tok')
    const source = h.result.current.webViewSource
    const builds = built.length
    h.rerender({ token: 'fresh' })
    expect(h.result.current.webViewSource).toBe(source)
    expect(built.length).toBe(builds)
    act(() => h.result.current.onRendererGone())
    expect(built.at(-1)!.token).toBe('fresh')
  })

  it('the first open waits for the token: built once it is ready, with it (a streamed open never probes without a Bearer)', () => {
    const h = mount('https://api.test/me/books/b1/file', null, false)
    h.rerender({ token: 'tok', ready: true })
    expect(h.result.current.webViewSource).toEqual({ html: '<pdf engine>', baseUrl: 'https://api.test' })
    expect(built.at(-1)).toEqual({ url: 'https://api.test/me/books/b1/file', token: 'tok', local: false })
  })
})
