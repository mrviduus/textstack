import { describe, it, expect, vi } from 'vitest'
import type { ChapterDoc, EngineEvents, Locator, ReaderEngine } from '../../../../packages/reader-engine/src/api'
import { startPdfPage, type PdfPageWindow } from './readerEnginePdfPage'

/**
 * The PDF engine page (ADR-025 Phase 5 slice 4) speaks the old PDF viewer's protocol: RN keeps calling
 * `scrollToPage(n, jumpId)`, `__setPdfHighlights`, `__pdfCreateHighlight` and reading `pdfReady` /
 * `pdfPage` / `pdfLoadError`, so `useReaderPdf` and its ADR-012 gate do not change. New: the bytes come
 * through `read()` with the bearer token, and a 401 asks RN for a token over the bridge — no reload.
 * The engine itself is faked here (its rules are E32–E42 in the package); this file is the translation.
 */

type Msg = { type: string; [k: string]: unknown }
const at = (n: number): Locator => ({ type: 'application/pdf', locations: { position: n } })
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)) }

function fakeEngine() {
  const handlers = new Map<string, ((p: unknown) => void)[]>()
  const opens: { doc: ChapterDoc; at?: Locator; opId?: string }[] = []
  const engine = {
    open: vi.fn(async (doc: ChapterDoc, a?: Locator, opId?: string) => { opens.push({ doc, at: a, opId }); return 'exact' }),
    goTo: vi.fn(async () => 'exact'),
    setStyle: vi.fn(),
    decorate: vi.fn(),
    clearSelection: vi.fn(),
    on: (e: string, cb: (p: unknown) => void) => { handlers.set(e, [...(handlers.get(e) ?? []), cb]); return () => {} },
  }
  const emit = <K extends keyof EngineEvents>(e: K, p: EngineEvents[K]) => handlers.get(e)?.forEach((cb) => cb(p))
  return { engine, emit, opens }
}

const FILE_LENGTH = 1000

/** A server answering ranges; the next `deny` requests get a 401. */
function server() {
  const s = {
    deny: 0,
    denyStatus: 401,
    calls: [] as { range: string | null; auth: string | null }[],
    hold: null as Promise<void> | null,
    fetch: vi.fn(async (_url: string, init?: RequestInit) => {
      const h = new Headers(init?.headers)
      s.calls.push({ range: h.get('Range'), auth: h.get('Authorization') })
      if (s.hold) await s.hold
      if (s.deny > 0) { s.deny--; return new Response(null, { status: s.denyStatus }) }
      const [a, b] = h.get('Range')!.replace('bytes=', '').split('-').map(Number)
      return new Response(new Uint8Array(b - a + 1), { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${FILE_LENGTH}` } })
    }),
  }
  return s
}

function boot(cfg: Partial<PdfPageWindow['__TS_PDF']> = {}, opts: { hold?: Promise<void>; xhr?: unknown; deny?: number; denyStatus?: number } = {}) {
  const messages: Msg[] = []
  const s = server()
  s.hold = opts.hold ?? null
  s.deny = opts.deny ?? 0
  s.denyStatus = opts.denyStatus ?? 401
  const fake = fakeEngine()
  const w = {
    __TS_PDF: { url: 'https://api.test/me/books/b1/file', token: 't1', initialPage: 7, local: false, safeTop: 24, ...cfg },
    ReactNativeWebView: { postMessage: (m: string) => messages.push(JSON.parse(m)) },
    fetch: s.fetch as unknown as typeof fetch,
    XMLHttpRequest: opts.xhr as typeof XMLHttpRequest,
  } as PdfPageWindow
  startPdfPage(fake.engine as unknown as ReaderEngine, w)
  const sent = (type: string) => messages.filter((m) => m.type === type)
  return { w, messages, sent, s, ...fake }
}

/** RN's answer to the page's latest token request, echoing its id. */
const answer = (p: ReturnType<typeof boot>, token: string | null) => p.w.__tsPdfToken!(token, p.sent('pdfTokenRequest').at(-1)!.id as number)

const source = (doc: ChapterDoc) => doc.pdf as { length: number; read(b: number, e: number): Promise<Uint8Array> }

describe('the PDF engine page', () => {
  it('lands pages below the top bar, opens the file by ranges with the bearer token at the bootstrap page', async () => {
    const p = boot()
    expect(p.engine.setStyle).toHaveBeenCalledWith({ insets: { top: 56 + 24, bottom: 0 } })
    await settle()
    expect(p.opens).toHaveLength(1)
    const { doc, at: where, opId } = p.opens[0]
    expect(doc.layout).toBe('fixed')
    expect(source(doc).length).toBe(FILE_LENGTH)
    expect(where).toEqual(at(7))
    expect(opId).toBe('0')
    expect(p.s.calls).toEqual([{ range: 'bytes=0-0', auth: 'Bearer t1' }])
  })

  it("says pdfReady with the page count, then acks the open's landing as the old viewer did (jumpId 0)", async () => {
    const p = boot()
    await settle()
    p.emit('relocated', { locator: at(1), reason: 'style' })   // the insets' ack before any page: nothing
    p.emit('ready', { opId: '0', pageCount: 40 })
    p.emit('relocated', { locator: at(7), reason: 'open', opId: '0' })
    expect(p.messages).toEqual([{ type: 'pdfReady', numPages: 40 }, { type: 'pdfPage', page: 7, numPages: 40, jumpId: 0 }])
  })

  it("an RN jump is a goTo with its jumpId as the op; a superseded op's ack is never reported; reading reports jumpId 0", async () => {
    const p = boot()
    await settle()
    p.emit('ready', { opId: '0', pageCount: 40 })
    p.w.scrollToPage!(12, 3)
    expect(p.engine.goTo).toHaveBeenCalledWith(at(12), { opId: '3' })
    p.w.scrollToPage!(20, 4)
    p.emit('relocated', { locator: at(20), reason: 'goTo', opId: '3' })   // 3 superseded, acked at 4's target
    p.emit('relocated', { locator: at(20), reason: 'goTo', opId: '4' })
    p.emit('relocated', { locator: at(21), reason: 'scroll' })
    expect(p.sent('pdfPage')).toEqual([
      { type: 'pdfPage', page: 20, numPages: 40, jumpId: 4 },
      { type: 'pdfPage', page: 21, numPages: 40, jumpId: 0 },
    ])
  })

  it('a jump RN asks for before the file is open is where the open goes, acked with its id', async () => {
    let release = () => {}
    const p = boot({}, { hold: new Promise<void>((r) => { release = r }) })
    p.w.scrollToPage!(30, 2)
    release()
    await settle()
    expect(p.opens[0].at).toEqual(at(30))
    expect(p.opens[0].opId).toBe('2')
  })

  it('a 401 asks RN for a token and the read retries with it: the same document, no reopen', async () => {
    const p = boot()
    await settle()
    p.s.deny = 1
    const chunk = source(p.opens[0].doc).read(0, 10)
    await settle()
    expect(p.sent('pdfTokenRequest')).toHaveLength(1)
    answer(p, 't2')
    expect((await chunk).length).toBe(10)
    expect(p.s.calls.at(-1)).toEqual({ range: 'bytes=0-9', auth: 'Bearer t2' })
    expect(p.opens).toHaveLength(1)
  })

  it('reads that 401 together share one token request', async () => {
    const p = boot()
    await settle()
    p.s.deny = 2
    const reads = [source(p.opens[0].doc).read(0, 10), source(p.opens[0].doc).read(10, 20)]
    await settle()
    expect(p.sent('pdfTokenRequest')).toHaveLength(1)
    answer(p, 't2')
    expect((await Promise.all(reads)).map((c) => c.length)).toEqual([10, 10])
  })

  it("no token from RN: the read rejects 'pdf-auth'; the engine's 'pdf-auth' is pdfAuthExpired; __tsPdfReopen reopens at the reader's page", async () => {
    const p = boot()
    await settle()
    p.emit('ready', { opId: '0', pageCount: 40 })
    p.emit('relocated', { locator: at(9), reason: 'scroll' })
    p.s.deny = 1
    const chunk = source(p.opens[0].doc).read(0, 10)
    await settle()
    answer(p, null)
    await expect(chunk).rejects.toEqual({ code: 'pdf-auth' })
    p.emit('error', { code: 'pdf-auth' })
    expect(p.sent('pdfAuthExpired')).toHaveLength(1)

    p.w.__tsPdfReopen!('t3')
    await settle()
    expect(p.opens).toHaveLength(2)
    expect(p.opens[1].at).toEqual(at(9))
    expect(p.s.calls.at(-1)!.auth).toBe('Bearer t3')
  })

  it("the file can't be had before the open: pdfAuthExpired for auth, else pdfLoadError; a failed read after ready only logs", async () => {
    const denied = boot({}, { deny: 2 })
    await settle()
    answer(denied, null)
    await settle()
    expect(denied.sent('pdfAuthExpired')).toHaveLength(1)
    expect(denied.opens).toHaveLength(0)

    const broken = boot()
    await settle()
    broken.emit('error', { code: 'pdf-load', detail: 'Invalid PDF structure.' })
    expect(broken.sent('pdfLoadError')).toEqual([{ type: 'pdfLoadError', message: 'Invalid PDF structure.' }])

    const late = boot()
    await settle()
    late.emit('ready', { opId: '0', pageCount: 4 })
    late.emit('error', { code: 'pdf-load', detail: 'a range' })
    expect(late.sent('pdfLoadError')).toEqual([])
    expect(late.sent('log')).toHaveLength(1)
  })

  it('a downloaded file is read off the disk whole: no network, no token', async () => {
    const urls: string[] = []
    class Xhr {
      status = 0   // a file:// read
      response: ArrayBuffer | null = null
      responseType = ''
      onload: (() => void) | null = null
      onerror: (() => void) | null = null
      open(_m: string, url: string) { urls.push(url) }
      send() { this.response = new ArrayBuffer(16); setTimeout(() => this.onload?.(), 0) }
    }
    const p = boot({ url: 'book.pdf', token: null, local: true }, { xhr: Xhr })
    await settle()
    await settle()
    expect(urls).toEqual(['book.pdf'])
    expect(p.s.fetch).not.toHaveBeenCalled()
    expect((p.opens[0].doc.pdf as { data: ArrayBuffer }).data.byteLength).toBe(16)
    expect(p.sent('pdfTokenRequest')).toEqual([])
  })

  it("a selection goes to RN as the old bridge's; Highlight posts today's PdfAnchor from its page and rects, then clears it", async () => {
    const p = boot()
    await settle()
    const rects = [{ x: 72, y: 96, w: 30, h: 12 }]
    p.emit('hold', { x: 1, y: 2 })
    p.emit('selection', {
      locator: { type: 'application/pdf', locations: { position: 3 }, text: { highlight: 'ships' }, ext: { rects } },
      text: 'ships', sentence: 'The keeper counted ships.', source: 'hold', tooLong: false, rect: { x: 0, y: 0, width: 1, height: 1 },
    })
    const [sel] = p.sent('selection')
    expect(p.messages[0]).toEqual({ type: 'wordEngage' })
    expect(sel).toMatchObject({ mode: 'tap', text: 'ships', sentence: 'The keeper counted ships.', tooLong: false })

    p.w.__pdfCreateHighlight!()
    expect(p.sent('pdfHighlightCreate')).toEqual([{ type: 'pdfHighlightCreate', anchor: { v: 1, kind: 'pdf', page: 3, rects, exact: 'ships' } }])
    expect(p.engine.clearSelection).toHaveBeenCalled()

    // RN's clear for an older selection does nothing; its own token clears.
    p.engine.clearSelection.mockClear()
    p.w.__tsClearSelection!((sel.token as number) - 1)
    expect(p.engine.clearSelection).not.toHaveBeenCalled()
    p.w.__tsClearSelection!(sel.token as number)
    expect(p.engine.clearSelection).toHaveBeenCalled()
  })

  it('highlights are painted by the engine in their colours; a tap on one is highlightTap, elsewhere tap (the bars)', async () => {
    const p = boot()
    await settle()
    const anchor = { v: 1, kind: 'pdf', page: 2, rects: [{ x: 1, y: 2, w: 3, h: 4 }], exact: 'x' }
    p.w.__setPdfHighlights!([{ id: 'h1', color: 'green', anchor }, { id: 'bad', color: 'pink', anchor: { kind: 'pdf' } }])
    const [group, items] = p.engine.decorate.mock.calls.at(-1) as unknown as [string, { id: string; locator: Locator; style: string }[]]
    expect(group).toBe('highlight')
    expect(items.map((i) => [i.id, i.style, i.locator.locations.position, i.locator.ext?.rects])).toEqual([['h1', 'rgba(187,247,208,0.5)', 2, anchor.rects]])

    p.emit('decorationTap', { group: 'highlight', id: 'h1', rect: { x: 0, y: 0, width: 1, height: 1 } })
    p.emit('tap', { x: 5, y: 5 })
    expect(p.messages).toEqual([{ type: 'highlightTap', highlightId: 'h1' }, { type: 'tap' }])
  })

  it('a new status-bar height moves where pages land (E42); the same one again does nothing', () => {
    const p = boot()
    p.w.__tsPdfInsets!(24)   // a bar toggle that did not change the status bar
    expect(p.engine.setStyle).toHaveBeenCalledTimes(1)
    p.w.__tsPdfInsets!(0)
    expect(p.engine.setStyle).toHaveBeenLastCalledWith({ insets: { top: 56, bottom: 0 } })
  })

  it("an insets change's 'style' ack is not a page report", async () => {
    const p = boot()
    await settle()
    p.emit('ready', { opId: '0', pageCount: 40 })
    p.emit('relocated', { locator: at(7), reason: 'open', opId: '0' })
    p.emit('relocated', { locator: at(7), reason: 'style' })
    expect(p.sent('pdfPage')).toHaveLength(1)
  })

  it('a 403 is no session to refresh: pdfLoadError, no token request', async () => {
    const p = boot({}, { deny: 1, denyStatus: 403 })
    await settle()
    expect(p.sent('pdfTokenRequest')).toEqual([])
    expect(p.sent('pdfAuthExpired')).toEqual([])
    expect(p.sent('pdfLoadError')).toHaveLength(1)
  })

  it('one reopen per session expiry: denied again after the reopen is pdfLoadError, not another pdfAuthExpired', async () => {
    const p = boot()
    await settle()
    p.emit('ready', { opId: '0', pageCount: 40 })
    p.emit('error', { code: 'pdf-auth' })
    p.s.deny = 2
    p.w.__tsPdfReopen!('t2')   // the fresh token is refused too
    await settle()
    answer(p, null)
    await settle()
    expect(p.sent('pdfAuthExpired')).toHaveLength(1)
    expect(p.sent('pdfLoadError')).toHaveLength(1)
  })

  it('a reopen that opened resets the bound: a later expiry reopens again', async () => {
    const p = boot()
    await settle()
    p.emit('ready', { opId: '0', pageCount: 40 })
    p.emit('error', { code: 'pdf-auth' })
    p.w.__tsPdfReopen!('t2')
    await settle()
    p.emit('ready', { opId: '0', pageCount: 40 })
    p.emit('error', { code: 'pdf-auth' })
    expect(p.sent('pdfAuthExpired')).toHaveLength(2)
  })

  it('a token request RN never answers gives up after 15 s as no token', async () => {
    vi.useFakeTimers()
    try {
      const p = boot({}, { deny: 2 })
      await vi.advanceTimersByTimeAsync(0)
      expect(p.sent('pdfTokenRequest')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(p.sent('pdfAuthExpired')).toHaveLength(1)
      // The next 401 asks again: the request did not stay stuck.
      const second = boot({}, { deny: 1 })
      await vi.advanceTimersByTimeAsync(0)
      answer(second, 't2')
      await vi.advanceTimersByTimeAsync(0)
      expect(second.opens).toHaveLength(1)
    } finally { vi.useRealTimers() }
  })

  it('a reopen keeps a jump that had not landed: the reopen goes there, with its id', async () => {
    const p = boot()
    await settle()
    p.emit('ready', { opId: '0', pageCount: 40 })
    p.emit('relocated', { locator: at(7), reason: 'open', opId: '0' })
    p.w.scrollToPage!(30, 5)   // a TOC jump; its pages never come: the session expired
    p.emit('error', { code: 'pdf-auth' })
    p.w.__tsPdfReopen!('t2')
    await settle()
    expect(p.opens[1].at).toEqual(at(30))
    expect(p.opens[1].opId).toBe('5')
  })

  it('a late answer, after its request timed out, does not answer a newer request', async () => {
    vi.useFakeTimers()
    try {
      const p = boot()
      await vi.advanceTimersByTimeAsync(0)
      p.s.deny = 2
      const first = source(p.opens[0].doc).read(0, 10).catch((e: unknown) => e)
      await vi.advanceTimersByTimeAsync(15_000)
      expect(await first).toEqual({ code: 'pdf-auth' })
      const second = source(p.opens[0].doc).read(10, 20)
      await vi.advanceTimersByTimeAsync(0)
      const [old, now] = p.sent('pdfTokenRequest').map((m) => m.id as number)
      expect(now).not.toBe(old)
      p.w.__tsPdfToken!('late', old)     // the first request's answer, finally
      p.w.__tsPdfToken!('t2', now)
      expect((await second).length).toBe(10)
      expect(p.s.calls.at(-1)!.auth).toBe('Bearer t2')
    } finally { vi.useRealTimers() }
  })

  it('only the newest open opens: an older one whose bytes come late is dropped, and the jump RN asked for meanwhile goes to the newest', async () => {
    let release = () => {}
    const p = boot({}, { hold: new Promise<void>((r) => { release = r }) })
    p.w.scrollToPage!(30, 2)
    p.w.__tsPdfReopen!('t2')   // a second open while the first one's bytes are still coming
    release()
    await settle()
    expect(p.opens).toHaveLength(1)
    expect(p.opens[0].at).toEqual(at(30))
    expect(p.opens[0].opId).toBe('2')
  })
})
