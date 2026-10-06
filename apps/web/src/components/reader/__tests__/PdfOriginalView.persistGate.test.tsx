import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import type { PdfDocumentState } from '../../../hooks/usePdfDocument'

// Bug R4-1: the persist effect fired as soon as pages were on screen, while the open-page jump
// was still waiting for the server resume answer. Page 1 went to localStorage after 500 ms and
// to the server after 2 s — over the reader's real place.

const PAGE_H = 1000
const docState: { current: PdfDocumentState } = {
  current: { pdf: null, numPages: 0, loading: true, error: null },
}
const saveUserBookProgress = vi.fn(async (..._a: unknown[]) => {})
const writePdfPage = vi.fn()
vi.mock('../../../hooks/usePdfDocument', () => ({ usePdfDocument: () => docState.current }))
vi.mock('../../../hooks/useTranslation', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('../../../api/userBooks', () => ({ saveUserBookProgress: (...a: unknown[]) => saveUserBookProgress(...a) }))
vi.mock('../../../lib/originalLayoutPref', () => ({
  readPdfPage: () => null,
  writePdfPage: (...a: unknown[]) => writePdfPage(...a),
}))
vi.mock('../PdfPage', () => ({
  PdfPage: ({ pageNumber, registerRef }: { pageNumber: number; registerRef: (el: HTMLElement | null) => void }) => (
    <div data-page={pageNumber} ref={registerRef} />
  ),
}))

import PdfOriginalView from '../PdfOriginalView'

let scrollTop = 0

beforeEach(() => {
  scrollTop = 0
  saveUserBookProgress.mockClear()
  writePdfPage.mockClear()
  // Every observed page is reported on screen, as the real observer does once pages render.
  vi.stubGlobal('IntersectionObserver', class {
    cb: IntersectionObserverCallback
    constructor(cb: IntersectionObserverCallback) { this.cb = cb }
    observe(el: Element) {
      setTimeout(() => this.cb([{ target: el, isIntersecting: true } as unknown as IntersectionObserverEntry], this as never), 0)
    }
    unobserve() {}
    disconnect() {}
  })
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0))
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get() { return this.classList.contains('pdf-original__scroll') ? scrollTop : 0 },
    set(v: number) { if (this.classList.contains('pdf-original__scroll')) scrollTop = v },
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const pn = Number(this.dataset.page)
    const top = pn ? (pn - 1) * PAGE_H - scrollTop : 0
    return { top, bottom: top + (pn ? PAGE_H : 800), left: 0, right: 600, width: 600, height: PAGE_H, x: 0, y: top, toJSON() {} } as DOMRect
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const loaded = (numPages: number): PdfDocumentState => ({
  pdf: { numPages, getPage: async () => ({ getViewport: () => ({ width: 600, height: PAGE_H }) }) } as never,
  numPages,
  loading: false,
  error: null,
})
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })

describe('PdfOriginalView — no save before the resume jump', () => {
  it('saves nothing while the resume answer is pending, then saves the resume page', async () => {
    docState.current = loaded(10)
    const base = { fileUrl: 'f', bookId: 'b1', initialPage: null, scrollToPage: null }
    const view = render(<PdfOriginalView {...base} resumePage={null} resumeReady={false} />)

    // Pages are on screen at page 1; the server is slow. Past both debounces.
    await wait(50)
    await wait(2300)
    expect(writePdfPage).not.toHaveBeenCalled()
    expect(saveUserBookProgress).not.toHaveBeenCalled()

    // The answer: page 7. The jump lands and THAT is what gets saved.
    view.rerender(<PdfOriginalView {...base} resumePage={7} resumeReady />)
    await wait(50)
    // The browser fires `scroll` for the jump; jsdom does not.
    act(() => { view.container.querySelector('.pdf-original__scroll')!.dispatchEvent(new Event('scroll')) })
    await wait(50)
    await wait(2300)
    expect(writePdfPage.mock.calls.map((c) => c[1])).not.toContain(1)
    expect(writePdfPage).toHaveBeenLastCalledWith('b1', 7)
    expect(saveUserBookProgress).toHaveBeenCalledTimes(1)
  })
})
