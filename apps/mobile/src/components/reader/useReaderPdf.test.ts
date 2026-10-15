// @vitest-environment jsdom
/**
 * Front-matter resume, through the real useReaderPdf (emulator bug, Compound Effect PDF):
 * the TOC's first chapter starts at page 5, the reader stopped on page 1. Continue routed to
 * chapter one, the bootstrap opened its start page 5, the resume clamp kept 5, and the first page
 * report saved `page:5` over `page:1`.
 */
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderHook } from '../../test/renderHook'
import { useReaderPdf } from './useReaderPdf'

const appState = vi.hoisted(() => {
  const listeners = new Set<(s: string) => void>()
  return { listeners, current: 'active', set(s: string) { appState.current = s; for (const l of [...listeners]) l(s) } }
})
vi.mock('react-native', () => ({
  AppState: {
    get currentState() { return appState.current },
    addEventListener: (_: string, fn: (s: string) => void) => {
      appState.listeners.add(fn)
      return { remove: () => appState.listeners.delete(fn) }
    },
  },
}))
const toast = vi.hoisted(() => ({ show: vi.fn((_o: { onPress?: () => void }) => 7), dismiss: vi.fn() }))
vi.mock('../../context/ToastContext', () => ({ useToast: () => toast }))
vi.mock('../../lib/api', () => ({ getAccessToken: async () => null, onUnauthorized: async () => null }))

const CHAPTERS = [
  { slug: 'one', title: 'One', sourceStartPage: 5 },
  { slug: 'two', title: 'Two', sourceStartPage: 40 },
]

function mount(chapterSlug: string, resumePage: number, startPage: number, picked = false) {
  const injected: string[] = []
  const persisted: number[] = []
  const h = renderHook(useReaderPdf, {
    original: true,
    originalFileUrl: 'file:///book.pdf',
    originalInitialPage: startPage,
    originalChapterPicked: picked,
    originalResumePage: resumePage,
    originalResumeReady: true,
    originalNewerPage: null,
    persistPdfPage: (p: number) => { persisted.push(p) },
    chapters: CHAPTERS as never,
    chapterSlug,
    injectJs: (js: string) => { injected.push(js) },
    language: 'en',
    aliveRef: { current: true },
    recordSessionActivity: () => {},
    repaintPdf: () => {},
  })
  const send = (data: object) => act(() => { h.result.current.onMessage(data) })
  return { h, injected, persisted, send }
}

const detail = readFileSync(resolve(__dirname, '../../../app/my-books/[id].tsx'), 'utf8')
const route = readFileSync(resolve(__dirname, '../../../app/my-books/read/[bookId]/[chapterSlug].tsx'), 'utf8')
const source = readFileSync(resolve(__dirname, './useUserBookReaderSource.ts'), 'utf8')

describe('wiring — the book-detail chapter row is a pick, Continue is not', () => {
  it('row passes ?pick=1; route and source thread it to originalChapterPicked', () => {
    expect(detail).toContain('router.push(`/my-books/read/${id}/${userBookChapterSlug(ch)}?pick=1`)')
    expect(detail).toContain('router.push(`/my-books/read/${id}/${slug}`)')
    expect(route).toContain("chapterPicked: pick === '1'")
    expect(source).toContain('originalChapterPicked: chapterPicked')
  })
})

const jumps = (injected: string[]) =>
  injected.map(js => /scrollToPage\((\d+), (\d+)\)/.exec(js)).filter(Boolean).map(m => ({ page: +m![1], id: +m![2] }))

describe('useReaderPdf — a saved page before the first chapter', () => {
  it('opens page 1, not chapter one\'s start, and saves page 1', () => {
    const r = mount('one', 1, 5)
    r.send({ type: 'pdfReady', numPages: 195 })
    expect(jumps(r.injected)).toEqual([{ page: 1, id: 1 }])
    // The bootstrap page 5 flashing by is not saved; the landing is.
    r.send({ type: 'pdfPage', page: 5, numPages: 195 })
    r.send({ type: 'pdfPage', page: 1, numPages: 195, jumpId: 1 })
    expect(r.persisted).toEqual([1])
  })

  it('a page beyond the document lands on the last page', () => {
    const r = mount('two', 200, 40)
    r.send({ type: 'pdfReady', numPages: 195 })
    expect(jumps(r.injected)).toEqual([{ page: 195, id: 1 }])
  })

  it('an explicit chapter-1 pick (book-detail row) opens its start 5, not the saved page 2', () => {
    const r = mount('one', 2, 5, true)
    r.send({ type: 'pdfReady', numPages: 195 })
    expect(jumps(r.injected)).toEqual([])
  })

  it('Continue into chapter 1 with a saved page 2 opens 2', () => {
    const r = mount('one', 2, 5)
    r.send({ type: 'pdfReady', numPages: 195 })
    expect(jumps(r.injected)).toEqual([{ page: 2, id: 1 }])
  })

  it('front matter does not override a later chapter the reader picked', () => {
    const r = mount('two', 1, 40)
    r.send({ type: 'pdfReady', numPages: 195 })
    expect(jumps(r.injected)).toEqual([])
  })
})

describe('useReaderPdf — a newer page from the server (R2 H3 review #4, M1)', () => {
  /** Chapter two opened at the saved page 45, then the reader read on to 50. */
  function readOn() {
    toast.show.mockClear()
    toast.dismiss.mockClear()
    const r = mount('two', 45, 40)
    r.send({ type: 'pdfReady', numPages: 195 })
    r.send({ type: 'pdfPage', page: 45, numPages: 195, jumpId: 1 })
    r.send({ type: 'pdfPage', page: 50, numPages: 195 })
    const offer = (o: { page: number; at: number; onReturn?: boolean }) => r.h.rerender({ originalNewerPage: o })
    return { ...r, offer }
  }

  it('a return offer measures "moved" from the page at the return: not moved since → goes there', () => {
    const r = readOn()
    act(() => appState.set('background'))
    act(() => appState.set('active'))                        // back on page 50
    r.offer({ page: 60, at: 1, onReturn: true })
    expect(jumps(r.injected).at(-1)).toMatchObject({ page: 60 })
    expect(toast.show).not.toHaveBeenCalled()
  })

  it('every offer is a new event: the same page offered twice asks twice', () => {
    const r = readOn()                                        // moved since the open (45 → 50)
    r.offer({ page: 60, at: 1 })
    r.offer({ page: 60, at: 2 })
    expect(toast.show).toHaveBeenCalledTimes(2)
    expect(jumps(r.injected).map(j => j.page)).toEqual([45])
  })

  it('the prompt is hidden when the reader closes (M1)', () => {
    const r = readOn()
    r.offer({ page: 60, at: 1 })
    r.h.unmount()
    expect(toast.dismiss).toHaveBeenCalledWith(7)
  })
})
