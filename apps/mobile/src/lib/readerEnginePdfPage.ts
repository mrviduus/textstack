// The PDF engine page (ADR-025 Phase 5 slice 4): runs INSIDE the reader WebView when
// EXPO_PUBLIC_READER_ENGINE_PDF is on. Like the reflow engine page (readerEnginePage.ts) it speaks the old
// viewer's protocol to RN — `scrollToPage(n, jumpId)`, `__setPdfHighlights`, `__pdfCreateHighlight` in;
// `pdfReady`, `pdfPage`, `pdfLoadError`, `pdfAuthExpired`, `pdfHighlightCreate`, `selection`, `tap`,
// `highlightTap` out — so `useReaderPdf` and its ADR-012 gate do not change. The engine's fixed layout
// draws the pages and keeps the place; this file only translates, and brings the bytes:
//   - streamed: the shared range source with the bearer token; a 401 asks RN for a token over the bridge
//     (`pdfTokenRequest` → `__tsPdfToken`), so the WebView is never rebuilt for a token (plan gap 3);
//   - downloaded (`local`): the file read off the disk whole, no network, no token (the reading path rule).
// Bundled with pdf.js by apps/web/scripts/pdfViewer/engineEntry.ts (outside the 64 KB engine budget).
import type { ChapterDoc, Locator, ReaderEngine } from '../../../../packages/reader-engine/src/api'
import { locatorToPdfAnchor, pdfAnchorToLocator } from '../../../../packages/reader-engine/src/mappers'
import { openPdfSource, type PdfSource } from '../../../../packages/shared/src/reader/pdfRangeSource'
import { HIGHLIGHT_BG } from './readerColors'

export interface PdfPageWindow {
  __TS_PDF: {
    url: string
    token: string | null
    /** The page to open at (the chapter's start, or the page a remount reopens). */
    initialPage: number | null
    /** A downloaded original: `url` is the file beside the document (file:// base). */
    local: boolean
    /** The status bar's height; the top bar sits under it. */
    safeTop: number
  }
  ReactNativeWebView: { postMessage(s: string): void }
  fetch: typeof fetch
  XMLHttpRequest: typeof XMLHttpRequest
  scrollToPage?(n: number, jumpId?: number): void
  __setPdfHighlights?(list: { id: string; color: string; anchor: unknown }[]): void
  __pdfCreateHighlight?(): void
  __tsClearSelection?(token: number | null): void
  /** RN's answer to `pdfTokenRequest {id}`: a fresh token, or null (the session is gone), and the request's id. */
  __tsPdfToken?(token: string | null, id: number): void
  /** After `pdfAuthExpired` and a successful refresh: open again, at the page the reader is on. */
  __tsPdfReopen?(token: string): void
  /** The status bar's height changed (ReaderShell's chrome injection). */
  __tsPdfInsets?(safeTop: number): void
}

/** ReaderShell's top bar over the WebView: `topBarHeight = 56 + insets.top`. */
const TOP_BAR_PX = 56
/** How long a read waits for RN's token answer before it counts as none. */
const TOKEN_WAIT_MS = 15_000

const at = (n: number): Locator => ({ type: 'application/pdf', locations: { position: n } })

export function startPdfPage(engine: ReaderEngine, w: PdfPageWindow): void {
  const cfg = w.__TS_PDF
  const post = (m: object) => w.ReactNativeWebView.postMessage(JSON.stringify(m))
  let token = cfg.token
  let numPages = 0
  let opened = false
  /** The op RN waits on: its jumpId ('0' = the page's own open). Acks of older ops are not landings. */
  let latest = '0'
  let page = cfg.initialPage ?? 1
  /** A jump RN asked for before the file was open: the open goes there. */
  let pending: { page: number; id: string } | null = null
  /** A jump not landed yet: a reopen goes there instead of the last reported page. */
  let travelling: { page: number; id: string } | null = null
  /** A reopen for this session expiry already ran: denied again is the end (no loop). Reset by `ready`. */
  let reopened = false
  let insetTop = -1
  let selected: Locator | null = null
  let selToken = Math.floor(Math.random() * 1e12)   // as the reflow page: a stale clear never matches

  // Every bar toggle re-injects the chrome: only a new height reaches the engine.
  w.__tsPdfInsets = (safeTop) => {
    const top = TOP_BAR_PX + safeTop
    if (top === insetTop) return
    insetTop = top
    engine.setStyle({ insets: { top, bottom: 0 } })
  }
  w.__tsPdfInsets(cfg.safeTop)

  engine.on('ready', ({ pageCount }) => {
    numPages = pageCount ?? 0
    reopened = false
    post({ type: 'pdfReady', numPages })
  })
  engine.on('relocated', ({ locator, reason, opId }) => {
    const n = locator.locations.position
    // An insets change's ack (not a place the reader chose), before a page, a superseded op's ack (at the
    // newer target), or no document.
    if (reason === 'style' || !opened || !n || !numPages || (opId !== undefined && opId !== latest)) return
    if (opId !== undefined) travelling = null
    page = n
    post({ type: 'pdfPage', page: n, numPages, jumpId: Number(opId ?? 0) || 0 })
  })
  engine.on('error', ({ code, detail }) => {
    if (code === 'pdf-auth') authLost()
    else if (code === 'pdf-load' && !numPages) post({ type: 'pdfLoadError', message: detail ?? code })
    else post({ type: 'log', level: 'warn', msg: `[engine] ${code}: ${detail ?? ''}` })
  })
  engine.on('tap', () => post({ type: 'tap' }))
  engine.on('decorationTap', (e) => { if (e.group === 'highlight') post({ type: 'highlightTap', highlightId: e.id }) })
  engine.on('hold', () => post({ type: 'wordEngage' }))
  engine.on('selection', (s) => {
    selToken++
    selected = s?.locator ?? null
    if (!s) return post({ type: 'selection', text: '' })
    // mode 'tap' = a held word: RN opens the WordCard for it. No text anchor: a PDF highlight is
    // made here, from the page and rects (`__pdfCreateHighlight`).
    post({ type: 'selection', mode: s.source === 'hold' ? 'tap' : 'drag', text: s.text, sentence: s.sentence, anchor: null, tooLong: s.tooLong, token: selToken })
  })

  /** RN refreshes once per expiry (pdfAuthExpired → __tsPdfReopen); denied again after that, the PDF can't load. */
  function authLost() {
    post(reopened ? { type: 'pdfLoadError', message: 'pdf-auth after a reopen' } : { type: 'pdfAuthExpired' })
  }

  // --- The bytes ---
  let asking: Promise<void> | null = null
  /** The request in flight: an answer for any other id (one that came after its timeout) is dropped. */
  let waiting: { id: number; answer(t: string | null): void } | null = null
  let requestId = 0
  /** One token request in flight; every read that got a 401 waits for it. An answer lost on the way
   *  (an injection into a busy WebView) counts as no token after TOKEN_WAIT_MS, so nothing waits forever. */
  const refresh = () => asking ??= new Promise<void>((ok, no) => {
    const id = ++requestId
    const timer = setTimeout(() => waiting?.answer(null), TOKEN_WAIT_MS)
    waiting = {
      id,
      answer(t) {
        clearTimeout(timer)
        waiting = null
        asking = null
        if (t) { token = t; ok() } else no(new Error('no token'))
      },
    }
    post({ type: 'pdfTokenRequest', id })
  })
  w.__tsPdfToken = (t, id) => { if (waiting && waiting.id === id) waiting.answer(t) }

  function source(): Promise<PdfSource> {
    if (cfg.local) return readFile(w, cfg.url).then((data) => ({ data }))
    return openPdfSource(cfg.url, {
      fetch: (...a) => w.fetch(...a),
      init: (): RequestInit => (token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      refresh,
    })
  }

  /** Opens the file at page n: once the bytes are there. A jump RN asks for meanwhile is newer, and wins. */
  function open(n: number, opId: string) {
    opened = false
    source().then(
      (pdf) => {
        const target = pending ?? { page: n, id: opId }
        pending = null
        opened = true
        latest = target.id
        numPages = 0
        void engine.open({ layout: 'fixed', pdf } as ChapterDoc, at(target.page), target.id)
      },
      (e: unknown) => {
        if ((e as { code?: string })?.code === 'pdf-auth') authLost()
        else post({ type: 'pdfLoadError', message: (e as Error)?.message ?? 'pdf-load' })
      },
    )
  }

  // --- RN → page ---
  w.scrollToPage = (n, jumpId = 0) => {
    const id = String(jumpId)
    if (!opened) { pending = { page: n, id }; return }
    latest = id
    travelling = { page: n, id }
    void engine.goTo(at(n), { opId: id })
  }
  w.__tsPdfReopen = (t) => {
    token = t
    reopened = true
    // A jump that had not landed (a TOC jump whose pages never came) is where the reader was going.
    pending = pending ?? travelling
    travelling = null
    open(page, '0')
  }
  w.__setPdfHighlights = (list) => {
    engine.decorate('highlight', (Array.isArray(list) ? list : []).flatMap((h) => {
      const locator = pdfAnchorToLocator(JSON.stringify(h.anchor))
      return locator ? [{ id: h.id, locator, style: HIGHLIGHT_BG[h.color] || HIGHLIGHT_BG.yellow }] : []
    }))
  }
  w.__pdfCreateHighlight = () => {
    const json = locatorToPdfAnchor(selected)
    if (json) post({ type: 'pdfHighlightCreate', anchor: JSON.parse(json) })
    engine.clearSelection()
  }
  w.__tsClearSelection = (t) => { if (typeof t !== 'number' || t === selToken) engine.clearSelection() }

  open(page, '0')
}

/** A downloaded file, whole. XHR, not fetch: a file:// document may XHR a sibling file (Android's
 *  allowFileAccessFromFileURLs), and `fetch` refuses the file scheme. */
function readFile(w: PdfPageWindow, url: string): Promise<ArrayBuffer> {
  return new Promise((ok, no) => {
    const x = new w.XMLHttpRequest()
    x.open('GET', url)
    x.responseType = 'arraybuffer'
    // A file:// read answers status 0.
    x.onload = () => (x.status === 0 || x.status === 200) && x.response ? ok(x.response as ArrayBuffer) : no(new Error(`PDF ${url}: ${x.status}`))
    x.onerror = () => no(new Error(`PDF ${url}: unreadable`))
    x.send()
  })
}
