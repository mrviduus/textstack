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
  /** RN's answer to `pdfTokenRequest`: a fresh token, or null (the session is gone). */
  __tsPdfToken?(token: string | null): void
  /** After `pdfAuthExpired` and a successful refresh: open again, at the page the reader is on. */
  __tsPdfReopen?(token: string): void
  /** The status bar's height changed (ReaderShell's chrome injection). */
  __tsPdfInsets?(safeTop: number): void
}

/** ReaderShell's top bar over the WebView: `topBarHeight = 56 + insets.top`. */
const TOP_BAR_PX = 56

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
  let selected: Locator | null = null
  let selToken = Math.floor(Math.random() * 1e12)   // as the reflow page: a stale clear never matches

  w.__tsPdfInsets = (safeTop) => engine.setStyle({ insets: { top: TOP_BAR_PX + safeTop, bottom: 0 } })
  w.__tsPdfInsets(cfg.safeTop)

  engine.on('ready', ({ pageCount }) => {
    numPages = pageCount ?? 0
    post({ type: 'pdfReady', numPages })
  })
  engine.on('relocated', ({ locator, opId }) => {
    const n = locator.locations.position
    // Before a page (the insets' ack), a superseded op's ack (at the newer target), or no document.
    if (!opened || !n || !numPages || (opId !== undefined && opId !== latest)) return
    page = n
    post({ type: 'pdfPage', page: n, numPages, jumpId: Number(opId ?? 0) || 0 })
  })
  engine.on('error', ({ code, detail }) => {
    if (code === 'pdf-auth') post({ type: 'pdfAuthExpired' })
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

  // --- The bytes ---
  let asking: Promise<void> | null = null
  /** One token request in flight; every read that got a 401 waits for it. */
  // ponytail: no timeout — RN always answers (onUnauthorized resolves, null on failure); add one if a
  // lost injection ever leaves a page blank on device.
  const refresh = () => asking ??= new Promise<void>((ok, no) => {
    w.__tsPdfToken = (t) => {
      asking = null
      if (t) { token = t; ok() } else no(new Error('no token'))
    }
    post({ type: 'pdfTokenRequest' })
  })

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
        if ((e as { code?: string })?.code === 'pdf-auth') post({ type: 'pdfAuthExpired' })
        else post({ type: 'pdfLoadError', message: (e as Error)?.message ?? 'pdf-load' })
      },
    )
  }

  // --- RN → page ---
  w.scrollToPage = (n, jumpId = 0) => {
    const id = String(jumpId)
    if (!opened) { pending = { page: n, id }; return }
    latest = id
    void engine.goTo(at(n), { opId: id })
  }
  w.__tsPdfReopen = (t) => {
    token = t
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
