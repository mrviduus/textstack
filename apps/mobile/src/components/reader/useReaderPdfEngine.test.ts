// @vitest-environment jsdom
/**
 * useReaderPdf (ADR-025 Phase 5 slice 4, plan gap 3): a token
 * refresh reaches the PDF engine page over the bridge. The WebView is never rebuilt for a token — the
 * old viewer's rebuild reopened pdf.js and the place had to be carried across it.
 */
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { t } from '@textstack/shared'
import { renderHook } from '../../test/renderHook'
import { useReaderPdf } from './useReaderPdf'
import { useReaderDocument } from './useReaderDocument'

const refresh = vi.fn(async (): Promise<string | null> => 'fresh')
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}))
const show = vi.fn((..._a: unknown[]) => 1)
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ show, dismiss: vi.fn() }) }))
vi.mock('../../lib/api', () => ({ API_URL: 'https://api.test', getAccessToken: async () => 't0', onUnauthorized: () => refresh() }))
// Counts document builds: a token refresh must not rebuild the WebView document.
const builds = vi.hoisted(() => ({ n: 0 }))
vi.mock('../../lib/readerHtml', () => ({ buildEngineReaderHtml: () => '<doc>', buildPdfEngineHtml: () => `<pdf ${++builds.n}>` }))

async function mount() {
  const injected: string[] = []
  const persisted: number[] = []
  // Wired as ReaderShell wires them: the PDF hook feeds the document hook.
  const both = (p: Parameters<typeof useReaderPdf>[0]) => {
    const pdf = useReaderPdf(p)
    const doc = useReaderDocument({
      original: true, originalFileUrl: p.originalFileUrl, originalInitialPage: p.originalInitialPage, htmlChapterSlug: 'one',
      injectJs: p.injectJs, reflow: (() => {}) as never, onDocumentRebuild: () => {}, chapter: { html: '' },
      settings: { fontSize: 18, lineHeight: 1.6, textAlign: 'left' } as never, resolvedFontFamily: 'serif',
      resolvedTheme: { backgroundColor: '#fff', textColor: '#000' } as never, insets: { top: 0, bottom: 0, left: 0, right: 0 },
      ...pdf,
    })
    return { ...pdf, webViewSource: doc.webViewSource }
  }
  const h = renderHook(both, {
    original: true,
    originalFileUrl: 'https://api.test/me/books/b1/file',
    originalInitialPage: 5,
    originalChapterPicked: false,
    originalResumePage: null,
    originalResumeReady: true,
    originalNewerPage: null,
    persistPdfPage: (p: number) => { persisted.push(p) },
    chapters: [{ slug: 'one', title: 'One', sourceStartPage: 5 }] as never,
    chapterSlug: 'one',
    injectJs: (js: string) => { injected.push(js) },
    language: 'en',
    aliveRef: { current: true },
    recordSessionActivity: () => {},
    repaintPdf: () => {},
  })
  await act(async () => {})   // the first token
  const send = async (data: object) => { await act(async () => { h.result.current.onMessage(data) }) }
  return { h, injected, persisted, send }
}

describe('useReaderPdf — engine PDF page, token over the bridge', () => {
  it('pdfTokenRequest: RN refreshes and hands the page the token, or null when the session is gone', async () => {
    const r = await mount()
    await r.send({ type: 'pdfTokenRequest', id: 7 })
    expect(r.injected.at(-1)).toBe('window.__tsPdfToken && window.__tsPdfToken("fresh", 7)')
    refresh.mockResolvedValueOnce(null)
    await r.send({ type: 'pdfTokenRequest', id: 8 })
    expect(r.injected.at(-1)).toBe('window.__tsPdfToken && window.__tsPdfToken(null, 8)')
  })

  it('a refresh that throws answers the page null (its read fails as pdf-auth), and counts as refused', async () => {
    const r = await mount()
    refresh.mockClear()
    show.mockClear()
    refresh.mockRejectedValueOnce(new Error('network'))
    await r.send({ type: 'pdfTokenRequest', id: 3 })
    expect(r.injected.at(-1)).toBe('window.__tsPdfToken && window.__tsPdfToken(null, 3)')
    await r.send({ type: 'pdfAuthExpired' })
    expect(refresh).toHaveBeenCalledTimes(1)   // refused: the toast, no second refresh
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('the refused state ends with the next document: a later expiry refreshes again', async () => {
    const r = await mount()
    refresh.mockClear()
    show.mockClear()
    refresh.mockResolvedValueOnce(null)
    await r.send({ type: 'pdfTokenRequest', id: 1 })
    await r.send({ type: 'pdfReady', numPages: 100 })
    await r.send({ type: 'pdfAuthExpired' })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(show).not.toHaveBeenCalled()
  })

  it('pdfAuthExpired: the page reopens itself at its page; the document is not rebuilt and the resume does not run again', async () => {
    const r = await mount()
    await r.send({ type: 'pdfReady', numPages: 100 })
    await r.send({ type: 'pdfPage', page: 5, numPages: 100, jumpId: 0 })
    await r.send({ type: 'pdfPage', page: 17, numPages: 100, jumpId: 0 })
    const initial = r.h.result.current.pdfInitialPageRef.current
    const source = r.h.result.current.webViewSource
    const built = builds.n
    expect(built, 'the PDF document was built').toBeGreaterThan(0)

    await r.send({ type: 'pdfAuthExpired' })
    expect(r.injected.at(-1)).toBe('window.__tsPdfReopen && window.__tsPdfReopen("fresh")')
    // No reload: the same document (the token is not in its key), not rebuilt, same start page.
    expect(r.h.result.current.webViewSource).toBe(source)
    expect(builds.n).toBe(built)
    expect(r.h.result.current.pdfInitialPageRef.current).toBe(initial)

    // The reopened document: no jump back to the chapter start; its landing on 17 is saved.
    const jumps = r.injected.length
    await r.send({ type: 'pdfReady', numPages: 100 })
    expect(r.injected.slice(jumps).filter((js) => js.includes('scrollToPage'))).toEqual([])
    await r.send({ type: 'pdfPage', page: 17, numPages: 100, jumpId: 0 })
    expect(r.persisted.at(-1)).toBe(17)
  })

  it('pdfAuthExpired before any document opened: the reopen is a first open, and the resume still runs', async () => {
    const r = await mount()
    await r.send({ type: 'pdfAuthExpired' })
    expect(r.h.result.current.pdfIsReloadRef.current).toBe(false)
  })

  it("a refreshed token is the hook's token too: a remount after a dead renderer opens with it", async () => {
    const r = await mount()
    expect(r.h.result.current.pdfToken).toBe('t0')
    await r.send({ type: 'pdfTokenRequest' })
    expect(r.h.result.current.pdfToken).toBe('fresh')
    refresh.mockResolvedValueOnce('fresher')
    await r.send({ type: 'pdfReady', numPages: 100 })
    await r.send({ type: 'pdfAuthExpired' })
    expect(r.h.result.current.pdfToken).toBe('fresher')
  })

  it('L4: a refresh after pdfAuthExpired that finds no session is not silent — a toast whose Retry runs the recovery again', async () => {
    const r = await mount()
    await r.send({ type: 'pdfReady', numPages: 100 })
    refresh.mockClear()
    show.mockClear()
    refresh.mockResolvedValueOnce(null)
    await r.send({ type: 'pdfAuthExpired' })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(r.injected.some(js => js.includes('__tsPdfReopen'))).toBe(false)
    expect(show).toHaveBeenCalledTimes(1)
    const shown = show.mock.calls[0][0] as { message: string; onPress(): void }
    expect(shown.message).toBe(t('en', 'reader.pdfReconnect'))
    expect(shown.message).not.toBe('reader.pdfReconnect')   // the copy exists
    await act(async () => { shown.onPress() })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(r.injected.at(-1)).toBe('window.__tsPdfReopen && window.__tsPdfReopen("fresh")')
  })

  it('pdfAuthExpired right after RN answered no token: the reconnect toast, no second refresh', async () => {
    const r = await mount()
    refresh.mockClear()
    show.mockClear()
    refresh.mockResolvedValueOnce(null)
    await r.send({ type: 'pdfTokenRequest' })
    await r.send({ type: 'pdfAuthExpired' })
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(show).toHaveBeenCalledTimes(1)
    // Retry runs the recovery: a refresh, and the reopen with its token.
    await act(async () => { (show.mock.calls[0][0] as { onPress(): void }).onPress() })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(r.injected.at(-1)).toBe('window.__tsPdfReopen && window.__tsPdfReopen("fresh")')
  })
})
