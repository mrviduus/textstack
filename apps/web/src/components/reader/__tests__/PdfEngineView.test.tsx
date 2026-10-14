import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, act, cleanup, fireEvent, screen } from '@testing-library/react'
import type { EngineEvents, Locator, ReaderEngine } from '@textstack/reader-engine'
import type { StoredHighlight } from '../../../lib/offlineDb'

// ADR-025 Phase 5 slice 3: web's Original-layout PDF through the engine's fixed layout. The view is the
// host: bytes (`openPdfSource`), where to open, what to save (the ADR-012 gate fed by the engine's acks),
// zoom, highlights (paint + tap → edit popup). The engine itself is faked: its events in, its calls out.
// Rewrites of PdfOriginalView.{persistGate,jump,loadError}.test.tsx at the host level.

vi.setConfig({ testTimeout: 15_000 })

type Handler = (p: unknown) => void
function fakeEngine() {
  const handlers: Record<string, Handler[]> = {}
  let here: number | null = null
  const engine = {
    on: (e: string, cb: Handler) => {
      (handlers[e] ??= []).push(cb)
      return () => { handlers[e] = handlers[e].filter((h) => h !== cb) }
    },
    open: vi.fn(async (_d: unknown, at?: Locator, _opId?: string) => { here = at?.locations.position ?? 1; return 'exact' }),
    goTo: vi.fn(async (at: Locator, _o?: { opId?: string }) => { here = at.locations.position ?? here; return 'exact' }),
    setStyle: vi.fn(),
    decorate: vi.fn(),
    clearSelection: vi.fn(),
    current: vi.fn(() => (here ? { type: 'application/pdf', locations: { position: here } } : null)),
    destroy: vi.fn(),
  }
  const emit = <K extends keyof EngineEvents>(e: K, p: EngineEvents[K]) => act(() => { handlers[e]?.forEach((h) => h(p)) })
  return { engine, emit }
}
let eng: ReturnType<typeof fakeEngine>
const createEngine = vi.fn((_root: HTMLElement, _o?: unknown) => eng.engine as unknown as ReaderEngine)
vi.mock('@textstack/reader-engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@textstack/reader-engine')>()),
  createEngine: (root: HTMLElement, o?: unknown) => createEngine(root, o),
}))
vi.mock('../pdfEngineLayout', () => ({ pdfFixedLayout: 'the host pdf.js layout' }))
const source = { length: 1000, read: vi.fn() }
const openPdfSource = vi.fn(async (..._a: unknown[]): Promise<unknown> => source)
vi.mock('../../../lib/pdfRangeSource', () => ({ openPdfSource: (...a: unknown[]) => openPdfSource(...a) }))
vi.mock('../../../api/auth', () => ({ refreshToken: vi.fn(async () => ({})) }))
vi.mock('../../../hooks/useTranslation', () => ({ useTranslation: () => ({ t: (k: string) => k }) }))
const saveUserBookProgress = vi.fn(async (..._a: unknown[]) => {})
vi.mock('../../../api/userBooks', () => ({ saveUserBookProgress: (...a: unknown[]) => saveUserBookProgress(...a) }))
const localPage: { current: number | null } = { current: null }
const writePdfPage = vi.fn()
vi.mock('../../../lib/originalLayoutPref', () => ({
  readPdfPage: () => localPage.current,
  writePdfPage: (...a: unknown[]) => writePdfPage(...a),
}))

import PdfEngineView from '../PdfEngineView'
import { mountedEngineFor } from '../../../lib/readerEngine'

const last = <T,>(xs: T[]): T => xs[xs.length - 1]
const wait = (ms: number) => act(async () => { await new Promise((r) => setTimeout(r, ms)) })
const page = (n: number): Locator => ({ type: 'application/pdf', locations: { position: n } })
const lastOpenPage = () => (last(eng.engine.open.mock.calls)[1] as Locator).locations.position
/** The engine acks the latest open / goTo with its page (the jump landed); an open says `ready` first. */
function ack(n?: number) {
  const opens = eng.engine.open.mock.calls.map((c) => ({ at: c[1] as Locator, opId: c[2] as string, reason: 'open' as const }))
  const gotos = eng.engine.goTo.mock.calls.map((c) => ({ at: c[0] as Locator, opId: c[1]!.opId as string, reason: 'goTo' as const }))
  const op = last([...opens, ...gotos].sort((a, b) => Number(a.opId) - Number(b.opId)))
  if (op.reason === 'open') eng.emit('ready', { opId: op.opId, pageCount: 40 })   // E32: ready, then the ack
  eng.emit('relocated', { locator: page(n ?? op.at.locations.position!), reason: op.reason, opId: op.opId })
}
const readerScrollsTo = (n: number) => eng.emit('relocated', { locator: page(n), reason: 'scroll' })
const savedPages = () => writePdfPage.mock.calls.map((c) => c[1])
function setVisibility(v: 'hidden' | 'visible') {
  Object.defineProperty(document, 'visibilityState', { value: v, configurable: true })
  return act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
}

const base = { fileUrl: '/me/books/b1/file', bookId: 'b1', initialPage: null, scrollToPage: null }

beforeEach(() => {
  eng = fakeEngine()
  localPage.current = null
  vi.clearAllMocks()
  openPdfSource.mockImplementation(async () => source)
})
afterEach(() => {
  cleanup()
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})

describe('PdfEngineView — the engine and its bytes', () => {
  it('mounts the engine with the host pdf.js layout and opens the file read by ranges', async () => {
    const onEngine = vi.fn()
    render(<PdfEngineView {...base} resumeReady onEngine={onEngine} />)
    await wait(0)
    expect(createEngine.mock.calls[0][1]).toEqual({ fixed: 'the host pdf.js layout' })
    expect(openPdfSource.mock.calls[0][0]).toBe('/me/books/b1/file')
    expect(eng.engine.open.mock.calls[0][0]).toEqual({ layout: 'fixed', pdf: source })
    expect(onEngine).toHaveBeenLastCalledWith('pdf:b1')
    expect(mountedEngineFor('pdf:b1')?.engine).toBe(eng.engine)
  })

  it('unmount destroys the engine and frees the slot', async () => {
    const onEngine = vi.fn()
    const view = render(<PdfEngineView {...base} resumeReady onEngine={onEngine} />)
    await wait(0)
    view.unmount()
    expect(eng.engine.destroy).toHaveBeenCalled()
    expect(mountedEngineFor('pdf:b1')).toBeNull()
    expect(onEngine).toHaveBeenLastCalledWith(null)
  })

  it('a load failure (pdf-load) hands over to the reflow fallback once', async () => {
    const onLoadError = vi.fn()
    render(<PdfEngineView {...base} resumeReady onLoadError={onLoadError} />)
    await wait(0)
    eng.emit('error', { code: 'pdf-load', detail: 'Bad PDF' })
    eng.emit('error', { code: 'pdf-load', detail: 'Bad PDF' })
    expect(onLoadError).toHaveBeenCalledTimes(1)
  })

  it('the session gone for good (pdf-auth): the banner; Reload reads the file again and reopens at the page', async () => {
    const onLoadError = vi.fn()
    render(<PdfEngineView {...base} resumeReady onLoadError={onLoadError} />)
    await wait(0)
    ack(1)
    readerScrollsTo(9)
    eng.emit('error', { code: 'pdf-auth' })
    expect(onLoadError).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('reader.originalLayout.reload'))
    await wait(0)
    expect(openPdfSource).toHaveBeenCalledTimes(2)
    expect(eng.engine.open).toHaveBeenCalledTimes(2)
    expect(lastOpenPage()).toBe(9)
  })

  it('the probe itself is denied: the banner, not the fallback', async () => {
    openPdfSource.mockImplementation(async () => { throw { code: 'pdf-auth' } })
    const onLoadError = vi.fn()
    render(<PdfEngineView {...base} resumeReady onLoadError={onLoadError} />)
    await wait(0)
    expect(screen.getByText('reader.originalLayout.sessionExpired')).toBeTruthy()
    expect(onLoadError).not.toHaveBeenCalled()
  })

  it('ready → page count up; relocated → the current page up, once per page; a tap → onTap', async () => {
    const onNumPages = vi.fn()
    const onPageChange = vi.fn()
    const onTap = vi.fn()
    render(<PdfEngineView {...base} resumeReady onNumPages={onNumPages} onPageChange={onPageChange} onTap={onTap} />)
    await wait(0)
    ack(1)
    readerScrollsTo(2)
    readerScrollsTo(2)
    eng.emit('tap', { x: 1, y: 1 })
    expect(onNumPages).toHaveBeenCalledWith(40)
    expect(onPageChange.mock.calls.map((c) => c[0])).toEqual([1, 2])
    expect(onTap).toHaveBeenCalled()
  })

  it('zoom buttons set the engine zoom; Fit goes back to 1', async () => {
    render(<PdfEngineView {...base} resumeReady />)
    await wait(0)
    fireEvent.click(screen.getByLabelText('reader.originalLayout.zoomIn'))
    expect(eng.engine.setStyle).toHaveBeenLastCalledWith({ zoom: 1.2 })
    fireEvent.click(screen.getByText('reader.originalLayout.fit'))
    expect(eng.engine.setStyle).toHaveBeenLastCalledWith({ zoom: 1 })
  })

  it('the page box jumps through the engine', async () => {
    render(<PdfEngineView {...base} resumeReady />)
    await wait(0)
    ack(1)
    const input = screen.getByLabelText('reader.originalLayout.goToPage')
    fireEvent.change(input, { target: { value: '12' } })
    fireEvent.submit(input.closest('form')!)
    expect((last(eng.engine.goTo.mock.calls)[0] as Locator).locations.position).toBe(12)
  })
})

describe('PdfEngineView — where it opens and what it saves (ADR-012 gate)', () => {
  it('saves nothing while the resume answer is pending, then opens at and saves the resume page (R4-1)', async () => {
    const view = render(<PdfEngineView {...base} resumePage={null} resumeReady={false} />)
    await wait(2300)
    expect(eng.engine.open).not.toHaveBeenCalled()
    view.rerender(<PdfEngineView {...base} resumePage={7} resumeReady />)
    await wait(0)
    expect(lastOpenPage()).toBe(7)
    ack()
    await wait(2300)
    expect(savedPages()).not.toContain(1)
    expect(last(writePdfPage.mock.calls).slice(0, 2)).toEqual(['b1', 7])
    expect(saveUserBookProgress).toHaveBeenCalledTimes(1)
  })

  it('the chapter\'s page wins over every resume page', async () => {
    localPage.current = 5
    render(<PdfEngineView {...base} initialPage={6} resumePage={7} resumeReady={false} />)
    await wait(0)
    expect(lastOpenPage()).toBe(6)
  })

  it('a page report before the open lands is never saved', async () => {
    localPage.current = 5
    render(<PdfEngineView {...base} resumeReady />)
    await wait(0)
    eng.emit('relocated', { locator: page(1), reason: 'style' })
    await wait(2300)
    expect(writePdfPage).not.toHaveBeenCalled()
  })

  it('an unanswered resume opens at this device\'s page and saves nothing until the reader moves', async () => {
    localPage.current = 5
    render(<PdfEngineView {...base} resumeReady resumeUnanswered />)
    await wait(0)
    expect(lastOpenPage()).toBe(5)
    ack()
    await wait(2300)
    expect(writePdfPage).not.toHaveBeenCalled()
    readerScrollsTo(7)
    await wait(2300)
    expect(savedPages()).toEqual([7, 7])
    expect(saveUserBookProgress).toHaveBeenCalledTimes(1)
  })

  it('the late answer: another device\'s newer page is adopted while the reader has not moved, and not saved back', async () => {
    localPage.current = 5
    const fetchNewerPage = vi.fn(async () => 12)
    render(<PdfEngineView {...base} resumeReady resumeUnanswered fetchNewerPage={fetchNewerPage} />)
    await wait(0)
    ack()
    await wait(50)
    expect(fetchNewerPage).toHaveBeenCalled()
    expect((last(eng.engine.goTo.mock.calls)[0] as Locator).locations.position).toBe(12)
    ack()
    await wait(2500)
    expect(saveUserBookProgress).not.toHaveBeenCalled()
  })

  it('the late answer never moves a reader who has moved', async () => {
    localPage.current = 5
    let answer!: (p: number | false | null) => void
    const fetchNewerPage = vi.fn(() => new Promise<number | false | null>((r) => { answer = r }))
    render(<PdfEngineView {...base} resumeReady resumeUnanswered fetchNewerPage={fetchNewerPage} />)
    await wait(0)
    ack()
    await wait(50)
    readerScrollsTo(8)
    await act(async () => { answer(12) })
    expect(eng.engine.goTo).not.toHaveBeenCalled()
  })

  it('a wheel within the page under a hold counts as moving, and survives a tab hide (#7)', async () => {
    localPage.current = 5
    const fetchNewerPage = vi.fn(async (): Promise<number | false | null> => null)
    render(<PdfEngineView {...base} resumeReady resumeUnanswered fetchNewerPage={fetchNewerPage} />)
    await wait(0)
    ack()
    await wait(50)
    act(() => { window.dispatchEvent(new Event('wheel')) })
    await setVisibility('hidden')
    fetchNewerPage.mockImplementation(async () => 15)
    await setVisibility('visible')
    await wait(50)
    expect(fetchNewerPage).toHaveBeenCalledTimes(2)
    expect(eng.engine.goTo).not.toHaveBeenCalled()
  })

  it('tab return: a newer page elsewhere moves a reader who has not moved since the tab was hidden', async () => {
    localPage.current = 3
    const fetchNewerPage = vi.fn(async (): Promise<number | false | null> => false)
    render(<PdfEngineView {...base} resumeReady fetchNewerPage={fetchNewerPage} />)
    await wait(0)
    ack()
    readerScrollsTo(4)
    await setVisibility('hidden')
    fetchNewerPage.mockImplementation(async () => 15)
    await setVisibility('visible')
    await wait(50)
    expect((last(eng.engine.goTo.mock.calls)[0] as Locator).locations.position).toBe(15)
  })

  it('an explicitly opened page (chapter start) is never replaced by a newer page', async () => {
    const fetchNewerPage = vi.fn(async () => 15)
    render(<PdfEngineView {...base} initialPage={6} resumeReady fetchNewerPage={fetchNewerPage} />)
    await wait(0)
    ack()
    await setVisibility('visible')
    await wait(50)
    expect(fetchNewerPage).toHaveBeenCalled()
    expect(eng.engine.goTo).not.toHaveBeenCalled()
  })

  it('a TOC jump during an unanswered hold is the reader\'s choice and is saved (#2)', async () => {
    localPage.current = 5
    const view = render(<PdfEngineView {...base} resumeReady resumeUnanswered />)
    await wait(0)
    ack()
    view.rerender(<PdfEngineView {...base} resumeReady resumeUnanswered scrollToPage={{ page: 14, nonce: 1 }} />)
    ack()
    await wait(2300)
    expect(savedPages()).toContain(14)
    expect(saveUserBookProgress).toHaveBeenCalledTimes(1)
  })

  it('a jump asked for before the open opens there, once (not replayed on a rerender)', async () => {
    const jump = { page: 5, nonce: 1 }
    const view = render(<PdfEngineView {...base} resumePage={2} resumeReady={false} scrollToPage={jump} />)
    await wait(0)
    expect(lastOpenPage()).toBe(5)
    ack()
    readerScrollsTo(8)
    view.rerender(<PdfEngineView {...base} resumePage={2} resumeReady scrollToPage={jump} />)
    await wait(0)
    expect(eng.engine.open).toHaveBeenCalledTimes(1)
    expect(eng.engine.goTo).not.toHaveBeenCalled()
  })

  it('leaving flushes the last page to the server at once', async () => {
    const view = render(<PdfEngineView {...base} resumeReady />)
    await wait(0)
    ack()
    readerScrollsTo(3)
    view.unmount()
    expect(saveUserBookProgress).toHaveBeenCalledTimes(1)
  })
})

describe('PdfEngineView — highlights', () => {
  const anchor = { v: 1 as const, kind: 'pdf' as const, page: 3, rects: [{ x: 10, y: 20, w: 30, h: 8 }], exact: 'the text' }
  const hl = { id: 'h1', anchor, color: 'green', selectedText: 'the text' } as unknown as StoredHighlight
  const reflowHl = { id: 'h2', anchor: { chapterId: 'c', startOffset: 0, endOffset: 3 }, color: 'yellow' } as unknown as StoredHighlight

  it('paints the PDF highlights from their stored anchors; reflow ones are not on the page', async () => {
    render(<PdfEngineView {...base} resumeReady highlights={[hl, reflowHl]} />)
    await wait(0)
    const [group, items] = last(eng.engine.decorate.mock.calls) as [string, { id: string; locator: Locator; style: string }[]]
    expect(group).toBe('highlight')
    expect(items.map((i) => i.id)).toEqual(['h1'])
    expect(items[0].locator.locations.position).toBe(3)
    expect(items[0].locator.ext?.rects).toEqual(anchor.rects)
    expect(items[0].style).toContain('187, 247, 208')
  })

  it('a tap on a painted highlight opens its edit popup; a recolor goes to the hook', async () => {
    const onHighlightUpdate = vi.fn()
    render(<PdfEngineView {...base} resumeReady highlights={[hl]} onHighlightUpdate={onHighlightUpdate} onHighlightDelete={vi.fn()} />)
    await wait(0)
    expect(document.querySelector('.pdf-hl-popup')).toBeNull()
    eng.emit('decorationTap', { group: 'highlight', id: 'h1', rect: { x: 10, y: 10, width: 20, height: 8 } })
    expect(document.querySelector('.pdf-hl-popup')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('blue'))
    expect(onHighlightUpdate).toHaveBeenCalledWith('h1', { color: 'blue' })
  })
})
