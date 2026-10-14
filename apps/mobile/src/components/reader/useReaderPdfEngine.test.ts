// @vitest-environment jsdom
/**
 * useReaderPdf with EXPO_PUBLIC_READER_ENGINE_PDF on (ADR-025 Phase 5 slice 4, plan gap 3): a token
 * refresh reaches the PDF engine page over the bridge. The WebView is never rebuilt for a token — the
 * old viewer's rebuild reopened pdf.js and the place had to be carried across it.
 */
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '../../test/renderHook'
import { useReaderPdf } from './useReaderPdf'

const refresh = vi.fn(async (): Promise<string | null> => 'fresh')
vi.mock('../../lib/readerEnginePdfFlag', () => ({ READER_ENGINE_PDF: true }))
vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}))
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ show: vi.fn(() => 1), dismiss: vi.fn() }) }))
vi.mock('../../lib/api', () => ({ getAccessToken: async () => 't0', onUnauthorized: () => refresh() }))

async function mount() {
  const injected: string[] = []
  const persisted: number[] = []
  const h = renderHook(useReaderPdf, {
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
    await r.send({ type: 'pdfTokenRequest' })
    expect(r.injected.at(-1)).toBe('window.__tsPdfToken && window.__tsPdfToken("fresh")')
    refresh.mockResolvedValueOnce(null)
    await r.send({ type: 'pdfTokenRequest' })
    expect(r.injected.at(-1)).toBe('window.__tsPdfToken && window.__tsPdfToken(null)')
  })

  it('pdfAuthExpired: the page reopens itself at its page; the document is not rebuilt and the resume does not run again', async () => {
    const r = await mount()
    await r.send({ type: 'pdfReady', numPages: 100 })
    await r.send({ type: 'pdfPage', page: 5, numPages: 100, jumpId: 0 })
    await r.send({ type: 'pdfPage', page: 17, numPages: 100, jumpId: 0 })
    const before = { token: r.h.result.current.pdfToken, nonce: r.h.result.current.pdfReloadNonce, initial: r.h.result.current.pdfInitialPageRef.current }

    await r.send({ type: 'pdfAuthExpired' })
    expect(r.injected.at(-1)).toBe('window.__tsPdfReopen && window.__tsPdfReopen("fresh")')
    const after = { token: r.h.result.current.pdfToken, nonce: r.h.result.current.pdfReloadNonce, initial: r.h.result.current.pdfInitialPageRef.current }
    expect(after).toEqual(before)

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
})
