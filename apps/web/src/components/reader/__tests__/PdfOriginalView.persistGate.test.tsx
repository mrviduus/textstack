import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.setConfig({ testTimeout: 15_000 })
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
const localPage: { current: number | null } = { current: null }
vi.mock('../../../lib/originalLayoutPref', () => ({
  readPdfPage: () => localPage.current,
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
  localPage.current = null
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
    expect(writePdfPage.mock.calls[writePdfPage.mock.calls.length - 1].slice(0, 2)).toEqual(['b1', 7])
    expect(saveUserBookProgress).toHaveBeenCalledTimes(1)
  })
})

const pageUnderTop = () => Math.floor(scrollTop / PAGE_H) + 1
/** The reader scrolls the viewer (outside the programmatic-scroll suppression window). */
async function userScrollTo(view: ReturnType<typeof render>, page: number) {
  await wait(300)
  scrollTop = (page - 1) * PAGE_H
  act(() => { view.container.querySelector('.pdf-original__scroll')!.dispatchEvent(new Event('scroll')) })
  await wait(50)
}

describe('PdfOriginalView — an unanswered resume (review #2)', () => {
  const base = { fileUrl: 'f', bookId: 'b1', initialPage: null, scrollToPage: null, resumePage: null }

  it('opens at this device\'s page and does not save it until the reader moves', async () => {
    docState.current = loaded(20)
    localPage.current = 5
    const view = render(<PdfOriginalView {...base} resumeReady resumeUnanswered />)
    await wait(50)
    act(() => { view.container.querySelector('.pdf-original__scroll')!.dispatchEvent(new Event('scroll')) })
    await wait(2500)
    expect(pageUnderTop()).toBe(5)
    expect(writePdfPage).not.toHaveBeenCalled()
    expect(saveUserBookProgress).not.toHaveBeenCalled()

    await userScrollTo(view, 7)
    await wait(2300)
    expect(writePdfPage.mock.calls.map((c) => c[1])).toEqual([7, 7])
    expect(saveUserBookProgress).toHaveBeenCalledTimes(1)
  })

  it('the late answer: a newer page from another device is adopted while the reader has not moved, and not saved back', async () => {
    docState.current = loaded(20)
    localPage.current = 5
    const fetchNewerPage = vi.fn(async () => 12)
    const view = render(<PdfOriginalView {...base} resumeReady resumeUnanswered fetchNewerPage={fetchNewerPage} />)
    await wait(50)
    act(() => { view.container.querySelector('.pdf-original__scroll')!.dispatchEvent(new Event('scroll')) })
    await wait(50)
    expect(fetchNewerPage).toHaveBeenCalled()
    expect(pageUnderTop()).toBe(12)
    await wait(2500)
    expect(saveUserBookProgress).not.toHaveBeenCalled()
  })

  it('the late answer never moves a reader who has moved', async () => {
    docState.current = loaded(20)
    localPage.current = 5
    let answer!: (p: number | false | null) => void
    const fetchNewerPage = vi.fn(() => new Promise<number | false | null>((r) => { answer = r }))
    const view = render(<PdfOriginalView {...base} resumeReady resumeUnanswered fetchNewerPage={fetchNewerPage} />)
    await wait(50)
    await userScrollTo(view, 8)
    await act(async () => { answer(12) })
    await wait(50)
    expect(pageUnderTop()).toBe(8)
  })
})

describe('PdfOriginalView — tab return (R4-4 for PDF)', () => {
  it('a newer page elsewhere moves a reader who has not moved since the tab was hidden', async () => {
    docState.current = loaded(20)
    localPage.current = 3
    const fetchNewerPage = vi.fn(async (): Promise<number | false | null> => false)
    const view = render(<PdfOriginalView fileUrl="f" bookId="b1" initialPage={null} scrollToPage={null} resumeReady fetchNewerPage={fetchNewerPage} />)
    await wait(50)
    await userScrollTo(view, 4)
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    fetchNewerPage.mockImplementation(async () => 15)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await wait(50)
    expect(pageUnderTop()).toBe(15)
  })

  it('an explicitly opened page (chapter start) is never replaced', async () => {
    docState.current = loaded(20)
    const fetchNewerPage = vi.fn(async () => 15)
    render(<PdfOriginalView fileUrl="f" bookId="b1" initialPage={6} scrollToPage={null} resumeReady fetchNewerPage={fetchNewerPage} />)
    await wait(50)
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await wait(50)
    expect(fetchNewerPage).toHaveBeenCalled()
    expect(pageUnderTop()).toBe(6)
  })
})

describe('PdfOriginalView — round 2', () => {
  const base = { fileUrl: 'f', bookId: 'b1', initialPage: null, resumePage: null }

  it('#2: a TOC jump during an unanswered hold is the reader\'s choice and is saved', async () => {
    docState.current = loaded(20)
    localPage.current = 5
    const view = render(<PdfOriginalView {...base} scrollToPage={null} resumeReady resumeUnanswered />)
    await wait(50)
    view.rerender(<PdfOriginalView {...base} scrollToPage={{ page: 14, nonce: 1 }} resumeReady resumeUnanswered />)
    await wait(50)
    act(() => { view.container.querySelector('.pdf-original__scroll')!.dispatchEvent(new Event('scroll')) })
    await wait(50)
    await wait(2300)
    expect(pageUnderTop()).toBe(14)
    expect(writePdfPage.mock.calls.map((c) => c[1])).toContain(14)
    expect(saveUserBookProgress).toHaveBeenCalledTimes(1)
  })

  it('#7: a same-page scroll under a hold survives a tab hide — the return check does not replace it', async () => {
    docState.current = loaded(20)
    localPage.current = 5
    const fetchNewerPage = vi.fn(async (): Promise<number | false | null> => null)
    const view = render(<PdfOriginalView {...base} scrollToPage={null} resumeReady resumeUnanswered fetchNewerPage={fetchNewerPage} />)
    await wait(50)
    // The reader nudges within page 5 (no page change → nothing saved, the hold stays).
    await wait(300)
    scrollTop = 4 * PAGE_H + 300
    act(() => { view.container.querySelector('.pdf-original__scroll')!.dispatchEvent(new Event('scroll')) })
    await wait(50)
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    fetchNewerPage.mockImplementation(async () => 15)
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await wait(50)
    expect(fetchNewerPage).toHaveBeenCalled()
    expect(pageUnderTop()).toBe(5)
  })
})
