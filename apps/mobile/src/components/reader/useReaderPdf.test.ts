// @vitest-environment jsdom
/**
 * Front-matter resume, through the real useReaderPdf (emulator bug, Compound Effect PDF):
 * the TOC's first chapter starts at page 5, the reader stopped on page 1. Continue routed to
 * chapter one, the bootstrap opened its start page 5, the resume clamp kept 5, and the first page
 * report saved `page:5` over `page:1`.
 */
import { act } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '../../test/renderHook'
import { useReaderPdf } from './useReaderPdf'

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => {} }) },
}))
vi.mock('../../context/ToastContext', () => ({ useToast: () => ({ show: vi.fn(() => 1), dismiss: vi.fn() }) }))
vi.mock('../../lib/api', () => ({ getAccessToken: async () => null, onUnauthorized: async () => null }))

const CHAPTERS = [
  { slug: 'one', title: 'One', sourceStartPage: 5 },
  { slug: 'two', title: 'Two', sourceStartPage: 40 },
]

function mount(chapterSlug: string, resumePage: number, startPage: number) {
  const injected: string[] = []
  const persisted: number[] = []
  const h = renderHook(useReaderPdf, {
    original: true,
    originalFileUrl: 'file:///book.pdf',
    originalInitialPage: startPage,
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
  return { injected, persisted, send }
}

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

  it('front matter does not override a later chapter the reader picked', () => {
    const r = mount('two', 1, 40)
    r.send({ type: 'pdfReady', numPages: 195 })
    expect(jumps(r.injected)).toEqual([])
  })
})
