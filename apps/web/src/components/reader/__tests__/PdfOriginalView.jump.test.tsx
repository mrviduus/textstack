import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act } from '@testing-library/react'
import type { PdfDocumentState } from '../../../hooks/usePdfDocument'

// A ?highlight= jump to a PDF page is requested as soon as highlights load —
// usually before pdf.js has opened the document. It used to be applied, then
// overridden by the open-page scroll, and replayed whenever numPages changed.

const PAGE_H = 1000
const docState: { current: PdfDocumentState } = {
  current: { pdf: null, numPages: 0, loading: true, error: null },
}
vi.mock('../../../hooks/usePdfDocument', () => ({ usePdfDocument: () => docState.current }))
vi.mock('../../../hooks/useTranslation', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
vi.mock('../../../api/userBooks', () => ({ saveUserBookProgress: vi.fn(async () => {}) }))
vi.mock('../PdfPage', () => ({
  PdfPage: ({ pageNumber, registerRef }: { pageNumber: number; registerRef: (el: HTMLElement | null) => void }) => (
    <div data-page={pageNumber} ref={registerRef} />
  ),
}))

import PdfOriginalView from '../PdfOriginalView'

// Pages stacked PAGE_H apart inside a scroll container whose scrollTop is real.
let scrollTop = 0
const pageUnderTop = () => Math.floor(scrollTop / PAGE_H) + 1

beforeEach(() => {
  scrollTop = 0
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} })
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
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 10)) })

const props = { fileUrl: 'f', bookId: 'b1', initialPage: null, resumePage: 2, resumeReady: true }

describe('PdfOriginalView — page jump requested before the document loads', () => {
  it('lands on the requested page, not the open page', async () => {
    const jump = { page: 5, nonce: 1 }
    const view = render(<PdfOriginalView {...props} scrollToPage={jump} />)
    docState.current = loaded(10)
    view.rerender(<PdfOriginalView {...props} scrollToPage={jump} />)
    await flush()
    expect(pageUnderTop()).toBe(5)
  })

  it('is applied once: a later numPages change does not replay it', async () => {
    const jump = { page: 5, nonce: 1 }
    docState.current = loaded(10)
    const view = render(<PdfOriginalView {...props} scrollToPage={jump} />)
    await flush()
    await flush() // page sizes in, the jump's correction pass done
    expect(pageUnderTop()).toBe(5)

    scrollTop = 7 * PAGE_H // the reader moves on to page 8
    docState.current = { ...docState.current, numPages: 11 }
    view.rerender(<PdfOriginalView {...props} scrollToPage={jump} />)
    await flush()
    expect(pageUnderTop()).toBe(8)
  })
})
