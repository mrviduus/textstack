// Vanilla-DOM PDF viewer controller for the MOBILE reader WebView (ADR-012 S4b).
//
// This is the non-React port of the web reader's Original-layout PDF view. It
// runs INSIDE a react-native-webview (no React), so the virtualization that
// PdfOriginalView.tsx + PdfPage.tsx + usePdfDocument.ts express as hooks is
// rewritten as an imperative controller. The PURE virtualization math is reused
// VERBATIM from @textstack/shared (computePageRings / resolveOpenPage /
// topVisiblePage / clampPage / dimsReadyUpTo) so web + mobile can never drift.
//
// Differences from web (intentional, see S4b notes):
//   - Auth: mobile has no cookies, so pdf.js gets `httpHeaders: { Authorization }`
//     + `withCredentials:false` (web uses `withCredentials:true`). Token comes in
//     via `window.__TS_PDF`.
//   - Scroll container: the WHOLE WebView body scrolls (window scroll) rather than
//     an inner overflow div — this lets the shared selection bridge's window-scroll
//     `scrollDir` detector drive the immersive chrome unchanged, and lets the
//     IntersectionObserver use the viewport as root.
//   - Worker: instantiated from a Blob built from the bundled legacy worker source
//     (`window.__TS_PDF_WORKER_SRC`, injected by the generated bundle) so canvas
//     raster stays off the UI thread on Android.
//   - No zoom/toolbar/invert/session-banner UI (that chrome is S4c) — just render +
//     selectable text + page-change + error/auth messages back to RN.
//   - Progress persistence is RN's job in S4c; here we only POST the top-visible
//     page so RN can restore it after a token-refresh reload.
//
// Bundled to an IIFE (es2017, minified) by apps/web/scripts/build-mobile-pdf.mjs.

// pdf.js LEGACY build — downlevelled for old Android Chromium WebViews.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.min.mjs'
import {
  computePageRings,
  resolveOpenPage,
  topVisiblePage,
  clampPage,
  dimsReadyUpTo,
  pageAtViewportTop,
  type PageRect,
} from '../../../../packages/shared/src/reader/pdfPageWindow'
import {
  buildPdfAnchor,
  paintRect,
  type PdfAnchor,
} from '../../../../packages/shared/src/reader/pdfHighlightAnchor'

interface PdfBootstrap {
  url: string
  token: string | null
  initialPage: number | null
}

interface PageDim {
  w: number
  h: number
}

interface PageState {
  el: HTMLElement
  canvas: HTMLCanvasElement | null
  textDiv: HTMLDivElement | null
  drawnScale: number | null
  renderTask: { cancel: () => void; promise: Promise<void> } | null
  textLayer: { cancel: () => void } | null
  hlLayer: HTMLDivElement | null
}

/** A persistent highlight pushed in from RN (`window.__setPdfHighlights`). */
interface PdfHighlight {
  id: string
  color: string
  anchor: PdfAnchor
}

const FALLBACK_DIM: PageDim = { w: 612, h: 792 } // US Letter @72dpi
const HORIZONTAL_PAD = 24
const PAGE_REPORT_THROTTLE_MS = 200
/** A jump never waits longer than this for the sizes above its target (slow stream, a size
 *  fetch that never returns): it lands where the column says the target is, and reports resume. */
const JUMP_DEADLINE_MS = 8000
/** No scroll event for this long (and no finger down) = the reader's scroll, fling included, is over. */
const SCROLL_IDLE_MS = 150

// Same pastel palette as the reflow overlay + web PdfHighlightLayer COLOR_MAP,
// as rgba so `mix-blend-mode: multiply` reads the alpha over the white scan.
const HL_COLOR_MAP: Record<string, string> = {
  yellow: 'rgba(254, 240, 138, 0.5)',
  green: 'rgba(187, 247, 208, 0.5)',
  pink: 'rgba(251, 207, 232, 0.5)',
  blue: 'rgba(191, 219, 254, 0.5)',
}

function post(msg: Record<string, unknown>): void {
  try {
    const rn = (window as unknown as { ReactNativeWebView?: { postMessage: (s: string) => void } }).ReactNativeWebView
    rn && rn.postMessage(JSON.stringify(msg))
  } catch {
    /* not in a WebView */
  }
}

/** 401/403-ish rejection from a lazy Range request after the token expired. */
function isAuthError(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  if (status === 401 || status === 403) return true
  const e = err as { message?: string; name?: string }
  return /401|403|unauthor|forbidden/i.test(`${e?.message || ''} ${e?.name || ''}`)
}

/** pdf.js cancel/abort exceptions are expected on scroll churn — ignore them. */
function isCancel(err: unknown): boolean {
  const name = (err as { name?: string })?.name || ''
  return /Cancel|Abort/i.test(name)
}

function main(): void {
  const cfg = (window as unknown as { __TS_PDF?: PdfBootstrap }).__TS_PDF
  if (!cfg || !cfg.url) {
    post({ type: 'pdfLoadError', message: 'missing bootstrap' })
    return
  }

  // --- Real worker off the UI thread: Blob → object URL → workerSrc. The
  //     bundled legacy worker source is injected as a global string by the
  //     generated bundle. Fallback to disableWorker only if it's absent. ---
  try {
    const workerSource = (window as unknown as { __TS_PDF_WORKER_SRC?: string }).__TS_PDF_WORKER_SRC
    if (workerSource) {
      const blob = new Blob([workerSource], { type: 'application/javascript' })
      ;(pdfjsLib as { GlobalWorkerOptions: { workerSrc: string } }).GlobalWorkerOptions.workerSrc =
        URL.createObjectURL(blob)
    }
  } catch (e) {
    console.warn('[pdf] worker blob setup failed', (e as Error)?.message)
  }

  const root = document.getElementById('pdf-root') || document.body
  const pagesEl = document.createElement('div')
  pagesEl.className = 'pdf-pages'
  root.appendChild(pagesEl)

  let pdf: {
    numPages: number
    getPage: (n: number) => Promise<{
      getViewport: (o: { scale: number }) => { width: number; height: number }
      render: (o: unknown) => { cancel: () => void; promise: Promise<void> }
      streamTextContent: () => unknown
    }>
    destroy: () => Promise<void>
  } | null = null
  let numPages = 0
  let scale = 1
  const pageDims: (PageDim | undefined)[] = []
  const states = new Map<number, PageState>()
  const visible = new Set<number>()
  // Persistent highlights pushed in from RN. Painted per-page over the text
  // layer; page-relative + unscaled so they survive scale / virtualization.
  let pdfHighlights: PdfHighlight[] = []
  let observer: IntersectionObserver | null = null
  // `pendingTarget` is the ONLY target concept. There used to be a second one:
  // a `didInitialScroll` self-jump to `openPage` that fired on the first
  // prefetch iteration and overwrote whatever RN had asked for milliseconds
  // earlier — so a resume to page 17 was reliably destroyed by a self-jump to
  // page 1. `openPage` is now a SEED for the same variable, leaving nothing to
  // clobber it with.
  let pendingTarget: number | null = null
  // Identifies the jump RN is waiting on, so the persist gate on the RN side can
  // tell "the reader is here" from "we are still travelling". 0 = viewer's own
  // boot seed, which RN never waits on.
  let pendingJumpId = 0
  let jumpDeadline: ReturnType<typeof setTimeout> | null = null
  let appliedJumpId = 0
  let lastReportedPage = -1
  let lastPageReportAt = 0
  let reportTimer: ReturnType<typeof setTimeout> | null = null
  // Reader scrolling (see applyPlaceholderSizes): a finger down, or a scroll event within the idle window.
  let touchDown = false
  let lastScrollAt = 0
  let deferredScale: number | null = null
  let deferTimer: ReturnType<typeof setTimeout> | null = null
  const openPage = resolveOpenPage(cfg.initialPage)

  /** The layout viewport. Not `innerWidth`: in a pinch-zoomable Android WebView that is the
   *  VISUAL viewport, which shrinks with the zoom — the fit then came out different per open. */
  function containerWidth(): number {
    return document.documentElement.clientWidth || window.innerWidth || 360
  }

  function computeScale(): number {
    const base = pageDims[0] || FALLBACK_DIM
    const fit = (containerWidth() - HORIZONTAL_PAD) / base.w
    return Math.min(5, Math.max(0.2, fit))
  }

  function pageBox(pn: number): { w: number; h: number } {
    const dim = pageDims[pn - 1] || pageDims[0] || FALLBACK_DIM
    return { w: Math.round(dim.w * scale), h: Math.round(dim.h * scale) }
  }

  /** Every change to the column's sizes — a measured page, a re-fit — goes through here, and keeps
   *  the reader where they are: a travelling jump stays aimed at its target, otherwise the page under
   *  the top line and how far into it (web's zoom anchor). Under a fixed scrollY the pages above
   *  changing height carried the reader off their page, and the next report saved that (+3 per
   *  reopen after a late re-fit; 139 → 146 after a TOC jump cancelled by a drag). */
  //
  // Not while the reader is scrolling: a programmatic scrollTo stops a fling in the WebView. The
  // change waits (newest scale wins) until scrolling is idle, and re-anchors then. A travelling jump
  // is re-aimed at once — it is not the reader's scroll.
  function applyPlaceholderSizes(nextScale = deferredScale ?? scale): void {
    if (pendingTarget == null && readerScrolling()) {
      deferredScale = nextScale
      if (!deferTimer) deferTimer = setTimeout(applyDeferred, SCROLL_IDLE_MS)
      return
    }
    deferredScale = null
    const anchor = pendingTarget == null ? captureAnchor() : null
    scale = nextScale
    states.forEach((st, pn) => {
      const box = pageBox(pn)
      st.el.style.width = box.w + 'px'
      st.el.style.height = box.h + 'px'
    })
    if (pendingTarget != null) { scrollToPageEl(pendingTarget); return }
    const d = anchor && anchorDelta(anchor)
    // Only when something above moved: a no-op scrollTo would still stop a fling.
    if (d && Math.abs(d) >= 1) window.scrollTo(0, Math.max(0, window.scrollY + d))
  }

  function applyDeferred(): void {
    deferTimer = null
    if (deferredScale == null) return
    applyPlaceholderSizes(deferredScale)   // re-defers itself if the reader is still scrolling
    if (deferredScale == null) syncRings() // a deferred re-fit redraws at the new scale
  }

  // ponytail: a touchstart whose touchend/touchcancel never arrives defers sizes until the next
  // touch ends; add a max deferral if QA ever sees a column stuck on estimates.
  function readerScrolling(): boolean {
    return touchDown || Date.now() - lastScrollAt < SCROLL_IDLE_MS
  }

  /** Where the top line sits relative to the page under it — unclamped, unlike the shared zoom
   *  anchor: above the page (the top padding, the margin, the gap between pages) is a negative
   *  offset kept as px, and restoring it as "page top" scrolled the padding away on every size
   *  change. Inside the page it is a fraction, so a re-fit keeps the same line. Null at the very
   *  top: the reader there stays there. */
  function captureAnchor(): { page: number; offset: number; fraction: number | null } | null {
    if (window.scrollY < 1) return null
    const rects = pageRects()
    const page = pageAtViewportTop(rects, 0)
    const r = page == null ? undefined : rects.find(x => x.page === page)
    if (!r) return null
    const offset = -r.top
    const h = r.bottom - r.top
    return { page: r.page, offset, fraction: offset >= 0 && h > 0 ? offset / h : null }
  }

  function anchorDelta(a: { page: number; offset: number; fraction: number | null }): number | null {
    const st = states.get(a.page)
    if (!st) return null
    const r = st.el.getBoundingClientRect()
    return r.top + (a.fraction == null ? a.offset : a.fraction * (r.bottom - r.top))
  }

  function pageRects(): PageRect[] {
    // ponytail: O(numPages) rect reads; binary-search the page column if a huge PDF ever shows up
    // in a scroll profile.
    const rects: PageRect[] = []
    states.forEach((st, pn) => {
      const r = st.el.getBoundingClientRect()
      rects.push({ page: pn, top: r.top, bottom: r.bottom })
    })
    return rects
  }

  function freePage(st: PageState): void {
    if (st.renderTask) { try { st.renderTask.cancel() } catch { /* noop */ } st.renderTask = null }
    if (st.textLayer) { try { st.textLayer.cancel() } catch { /* noop */ } st.textLayer = null }
    if (st.canvas) {
      st.canvas.width = 0
      st.canvas.height = 0
      if (st.canvas.parentNode) st.canvas.parentNode.removeChild(st.canvas)
      st.canvas = null
    }
    if (st.textDiv) {
      if (st.textDiv.parentNode) st.textDiv.parentNode.removeChild(st.textDiv)
      st.textDiv = null
    }
    if (st.hlLayer) {
      if (st.hlLayer.parentNode) st.hlLayer.parentNode.removeChild(st.hlLayer)
      st.hlLayer = null
    }
    st.drawnScale = null
    const ph = st.el.querySelector('.pdf-page__placeholder') as HTMLElement | null
    if (ph) ph.style.display = ''
  }

  // --- Persistent PDF highlights (ADR "PDF highlights" S-c) ----------------
  // Paint one positioned <div> per stored quad-rect over the text layer, tinted
  // by color. Rects are page-relative + unscaled (scale=1 viewport space); the
  // shared `paintRect` scales them to the live render scale — identical math to
  // the web PdfHighlightLayer, so web + mobile paint pixel-for-pixel the same.

  /** Repaint one page's highlight layer from `pdfHighlights` at the live scale. */
  function paintPageHighlights(pn: number, st: PageState): void {
    if (st.hlLayer) {
      if (st.hlLayer.parentNode) st.hlLayer.parentNode.removeChild(st.hlLayer)
      st.hlLayer = null
    }
    const pageHls = pdfHighlights.filter(
      (h) => h.anchor && h.anchor.page === pn && h.anchor.rects && h.anchor.rects.length > 0,
    )
    if (pageHls.length === 0) return
    const layer = document.createElement('div')
    layer.className = 'pdf-hl-layer'
    for (let hi = 0; hi < pageHls.length; hi++) {
      const h = pageHls[hi]
      for (let i = 0; i < h.anchor.rects.length; i++) {
        const box = paintRect(h.anchor.rects[i], scale)
        const div = document.createElement('div')
        div.className = 'pdf-hl-rect'
        div.dataset.highlightId = h.id
        div.style.left = box.left + 'px'
        div.style.top = box.top + 'px'
        div.style.width = box.width + 'px'
        div.style.height = box.height + 'px'
        div.style.background = HL_COLOR_MAP[h.color] || HL_COLOR_MAP.yellow
        // M2: the rect is pointer-events:none (CSS) so a drag STARTING over an
        // existing highlight still hits the text layer beneath and can
        // (re)select. Tap-to-edit is restored via the geometric hit-test in
        // `__pdfHighlightAtPoint` (consumed by the shared bridge's touchend) —
        // no per-rect click handler (which needed pointer-events:auto).
        layer.appendChild(div)
      }
    }
    st.el.appendChild(layer)
    st.hlLayer = layer
  }

  /** Repaint every drawn page (undrawn pages repaint when drawPage finishes). */
  function repaintAllHighlights(): void {
    states.forEach((st, pn) => {
      if (st.drawnScale !== null) paintPageHighlights(pn, st)
    })
  }

  /** Nearest ancestor (inclusive) that is a `.pdf-page[data-page]`. */
  function findPageEl(node: Node | null): HTMLElement | null {
    let cur: Node | null = node
    while (cur) {
      if (cur.nodeType === 1) {
        const el = cur as HTMLElement
        if (el.classList && el.classList.contains('pdf-page') && el.dataset.page) return el
      }
      cur = cur.parentNode
    }
    return null
  }

  /**
   * Build a PdfAnchor from the current live selection over the pdf.js text
   * layer. Mirrors web `computePdfAnchorFromRange` — walks to the start page,
   * uses the controller's tracked `scale`, and hands raw client rects to the
   * shared `buildPdfAnchor`. Returns null when the selection isn't inside a
   * rendered page or yields no in-page rects.
   */
  function computeAnchorFromRange(range: Range): PdfAnchor | null {
    const pageEl = findPageEl(range.startContainer)
    if (!pageEl) return null
    const page = Number(pageEl.dataset.page)
    if (!page) return null
    const pageRect = pageEl.getBoundingClientRect()
    const clientRects = Array.from(range.getClientRects())
    const exact = range.toString()
    const anchor = buildPdfAnchor(
      page,
      { left: pageRect.left, top: pageRect.top, width: pageRect.width, height: pageRect.height },
      clientRects,
      scale,
      exact,
    )
    return anchor.rects.length > 0 ? anchor : null
  }

  async function drawPage(pn: number, st: PageState): Promise<void> {
    if (!pdf) return
    if (st.drawnScale === scale) return
    // Redraw at new scale — drop the stale canvas first.
    if (st.drawnScale !== null) freePage(st)
    try {
      const page = await pdf.getPage(pn)
      if (!states.has(pn) || states.get(pn) !== st) return
      const viewport = page.getViewport({ scale })
      const outputScale = window.devicePixelRatio || 1

      const canvas = document.createElement('canvas')
      canvas.className = 'pdf-page__canvas'
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      canvas.width = Math.floor(viewport.width * outputScale)
      canvas.height = Math.floor(viewport.height * outputScale)
      canvas.style.width = Math.floor(viewport.width) + 'px'
      canvas.style.height = Math.floor(viewport.height) + 'px'
      st.el.appendChild(canvas)
      st.canvas = canvas
      const ph = st.el.querySelector('.pdf-page__placeholder') as HTMLElement | null
      if (ph) ph.style.display = 'none'

      const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined
      const task = page.render({ canvasContext: ctx, viewport, transform }) as PageState['renderTask']
      st.renderTask = task
      await task!.promise
      if (states.get(pn) !== st) return

      const textDiv = document.createElement('div')
      textDiv.className = 'textLayer'
      textDiv.style.setProperty('--scale-factor', String(scale))
      textDiv.style.width = Math.floor(viewport.width) + 'px'
      textDiv.style.height = Math.floor(viewport.height) + 'px'
      st.el.appendChild(textDiv)
      st.textDiv = textDiv
      const TextLayerCtor = (pdfjsLib as unknown as { TextLayer: new (o: unknown) => { render: () => Promise<void>; cancel: () => void } }).TextLayer
      const tl = new TextLayerCtor({
        textContentSource: page.streamTextContent(),
        container: textDiv,
        viewport,
      })
      st.textLayer = tl
      await tl.render()
      if (states.get(pn) !== st) return
      st.drawnScale = scale
      // Paint any persistent highlights for this page now that the text layer
      // (their coord reference) exists. Re-mount / redraw repaints from the
      // pushed list, so scroll-away → scroll-back stays correct.
      paintPageHighlights(pn, st)
    } catch (err) {
      if (isCancel(err)) return
      if (isAuthError(err)) {
        // A mid-read Range 401 → ask RN to silently refresh + reload (S4b:
        // no visible banner). RN rebuilds the source with a fresh token,
        // restoring the current page.
        post({ type: 'pdfAuthExpired' })
        return
      }
      console.warn('[pdf] page render failed', pn, (err as Error)?.message)
    }
  }

  function syncRings(): void {
    if (!numPages) return
    const rings = computePageRings(visible, numPages)
    // Free anything outside the keep ring.
    states.forEach((st, pn) => {
      if (!rings.keep.has(pn)) {
        if (st.drawnScale !== null || st.canvas) freePage(st)
      }
    })
    // Draw pages in the render ring.
    rings.render.forEach((pn) => {
      const st = states.get(pn)
      if (st && st.drawnScale !== scale) void drawPage(pn, st)
    })
  }

  function reportTopPage(): void {
    // Travelling: the jump has not landed, and the page under the top is wherever estimated
    // heights put it. RN saves what it is told (a ±1 landing or the 4s settle opens its gate),
    // so these pages became the position and every reopen drifted. The landing reports itself.
    if (pendingTarget != null) return
    const now = Date.now()
    const wait = PAGE_REPORT_THROTTLE_MS - (now - lastPageReportAt)
    if (wait > 0) {
      // Trailing edge. Leading-only throttling silently dropped the LAST page
      // change of a scroll: if the reader stopped moving inside the window, that
      // page was never reported and so never saved.
      if (!reportTimer) reportTimer = setTimeout(() => { reportTimer = null; reportTopPage() }, wait)
      return
    }
    if (reportTimer) { clearTimeout(reportTimer); reportTimer = null }
    lastPageReportAt = now
    const top = currentPage()
    if (top === lastReportedPage) return
    lastReportedPage = top
    post({ type: 'pdfPage', page: top, numPages, jumpId: appliedJumpId })
  }

  /** The page under the viewport top. `visible` is the RENDER set (300px
   *  rootMargin): its lowest page is usually the one above, and saving that made
   *  every open land a page earlier (C3). Measures every page, not just
   *  `visible`, because right after a jump the observer has not caught up yet. */
  function currentPage(): number {
    return pageAtViewportTop(pageRects(), 0) ?? topVisiblePage(visible, openPage)
  }

  /** Report immediately, bypassing the throttle and the unchanged-page check.
   *  Used to acknowledge a landed jump: the top page after a jump is often the
   *  page already reported, so without this the acknowledgement never ships. */
  function reportTopPageNow(): void {
    lastPageReportAt = 0
    lastReportedPage = -1
    reportTopPage()
  }

  function scrollToPageEl(pn: number): void {
    const st = states.get(pn)
    if (!st) return
    const y = st.el.getBoundingClientRect().top + window.scrollY
    window.scrollTo(0, Math.max(0, y))
  }

  function jumpToPage(raw: number, jumpId = 0): void {
    const target = clampPage(raw, numPages)
    pendingTarget = target
    pendingJumpId = jumpId
    armJumpDeadline()
    scrollToPageEl(target)
    // Every size above it already known (the prefetch may be done): this IS the landing.
    settleIfReady()
  }

  /** Land the pending jump once every page above it is measured — sizes applied, scrolled,
   *  acknowledged. One path for the boot seed and every RN jump. Synchronous: reading the rect
   *  forces the layout the new sizes produce, and no report can slip in between. */
  function settleIfReady(): void {
    if (pendingTarget == null || !dimsReadyUpTo(pageDims, pendingTarget)) return
    applyPlaceholderSizes()
    endJump(true)
  }

  /** The jump is over: landed on its target (`scroll`), or cancelled by the reader where they
   *  are. Either way acknowledged, so RN's gate opens on the page now under the top. */
  function endJump(scroll: boolean): void {
    if (pendingTarget == null) return
    const t = pendingTarget
    const id = pendingJumpId
    if (scroll) scrollToPageEl(t)
    pendingTarget = null
    pendingJumpId = 0
    if (jumpDeadline) { clearTimeout(jumpDeadline); jumpDeadline = null }
    appliedJumpId = id
    // Tell RN this jump landed. Position alone is ambiguous — the page it would
    // report may be the one it already reported — so the id travels.
    reportTopPageNow()
  }

  function armJumpDeadline(): void {
    if (jumpDeadline) clearTimeout(jumpDeadline)
    // Sizes that arrive after the deadline keep the landed page under the top (applyPlaceholderSizes).
    jumpDeadline = setTimeout(() => { jumpDeadline = null; applyPlaceholderSizes(); endJump(true) }, JUMP_DEADLINE_MS)
  }

  // The reader's own gesture cancels a travelling jump (as the web reader does): their place is
  // where they scroll to, and a late landing must not snap them back. Input events, not `scroll`:
  // sizes streaming in above (and the browser's scroll anchoring) move scrollY with no reader.
  const cancelJump = () => endJump(false)
  for (const type of ['touchmove', 'wheel', 'keydown']) window.addEventListener(type, cancelJump, { passive: true })
  window.addEventListener('touchstart', () => { touchDown = true }, { passive: true })
  for (const type of ['touchend', 'touchcancel']) {
    window.addEventListener(type, () => { touchDown = false; lastScrollAt = Date.now() }, { passive: true })
  }
  window.addEventListener('scroll', () => { lastScrollAt = Date.now() }, { passive: true })

  function buildPageEls(): void {
    const frag = document.createDocumentFragment()
    for (let pn = 1; pn <= numPages; pn++) {
      const el = document.createElement('div')
      el.className = 'pdf-page'
      el.dataset.page = String(pn)
      const box = pageBox(pn)
      el.style.width = box.w + 'px'
      el.style.height = box.h + 'px'
      const ph = document.createElement('div')
      ph.className = 'pdf-page__placeholder'
      ph.textContent = String(pn)
      el.appendChild(ph)
      frag.appendChild(el)
      states.set(pn, { el, canvas: null, textDiv: null, drawnScale: null, renderTask: null, textLayer: null, hlLayer: null })
    }
    pagesEl.appendChild(frag)
  }

  function observeAll(): void {
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const pn = Number((e.target as HTMLElement).dataset.page)
          if (!pn) continue
          if (e.isIntersecting) visible.add(pn)
          else visible.delete(pn)
        }
        syncRings()
        reportTopPage()
      },
      { root: null, rootMargin: '300px 0px' },
    )
    states.forEach((st) => observer!.observe(st.el))
    // The observer only fires when a page enters/leaves the 300px band, not when
    // a page boundary crosses the viewport top — so the page change rides scroll.
    window.addEventListener('scroll', reportTopPage, { passive: true })
  }

  async function prefetchDims(): Promise<void> {
    if (!pdf) return
    for (let i = 1; i <= numPages; i++) {
      try {
        const page = await pdf.getPage(i)
        const vp = page.getViewport({ scale: 1 })
        pageDims[i - 1] = { w: vp.width, h: vp.height }
        // First real dim → the fit scale for this document.
        if (i === 1) applyPlaceholderSizes(computeScale())
        else if (i % 10 === 0) applyPlaceholderSizes()
      } catch {
        // Keep the estimate pageBox already draws it at — recorded, so a jump past this page can
        // still land (an unmeasured page would hold it, and the reports, forever).
        pageDims[i - 1] = pageDims[0] || FALLBACK_DIM
      }
      // Heights stream in lazily, so a jump issued before the pages above the target are
      // measured lands in the wrong place and has to be redone once they are.
      settleIfReady()
    }
    applyPlaceholderSizes()
    syncRings()
  }

  async function loadDocument(attempt: number): Promise<void> {
    const params: Record<string, unknown> = {
      url: cfg.url,
      withCredentials: false,
      // Lazy Range streaming (default) → instant first paint + bounded memory.
    }
    if (cfg.token) params.httpHeaders = { Authorization: 'Bearer ' + cfg.token }
    try {
      const task = (pdfjsLib as unknown as { getDocument: (o: unknown) => { promise: Promise<typeof pdf> } }).getDocument(params)
      pdf = await task.promise
      if (!pdf) throw new Error('empty document')
      numPages = pdf.numPages
      buildPageEls()
      applyPlaceholderSizes(computeScale())
      observeAll()
      // Seed the one target variable. `pendingTarget` may already hold a page RN
      // asked for before the document finished opening — that request is newer
      // and more specific, so it wins. This ordering is the fix: the seed used to
      // be a separate self-jump that overwrote RN's request instead.
      if (pendingTarget == null && openPage > 1) pendingTarget = clampPage(openPage, numPages)
      if (pendingTarget != null) armJumpDeadline()
      post({ type: 'pdfReady', numPages })
      void prefetchDims()
    } catch (err) {
      if (isAuthError(err)) {
        post({ type: 'pdfAuthExpired' })
        return
      }
      if (attempt === 0) {
        await loadDocument(1)
        return
      }
      post({ type: 'pdfLoadError', message: (err as Error)?.message || 'failed to load pdf' })
    }
  }

  // Inbound: RN asks us to scroll to a page (TOC jump / restore).
  ;(window as unknown as { scrollToPage: (n: number, jumpId?: number) => void }).scrollToPage = (
    n: number,
    jumpId = 0,
  ) => {
    if (numPages) jumpToPage(n, jumpId)
    else {
      // Not ready yet — remember it as the open target. Same variable the boot
      // seed uses, so whichever arrives last wins and neither is lost.
      pendingTarget = n
      pendingJumpId = jumpId
    }
  }

  // Inbound: RN pushes the current PDF highlight list (load + after
  // create/recolor/delete). We store it and repaint every drawn page; pages
  // that mount later paint from this list in drawPage.
  ;(window as unknown as { __setPdfHighlights: (list: PdfHighlight[]) => void }).__setPdfHighlights = (
    list: PdfHighlight[],
  ) => {
    pdfHighlights = Array.isArray(list) ? list : []
    repaintAllHighlights()
  }

  // M2 hit-test: return the highlightId of the painted rect under a viewport
  // point, or null. Because the rects are pointer-events:none (so selection
  // works over them), they are excluded from `document.elementsFromPoint`, so
  // we test the live rect geometry directly. Consumed by the shared selection
  // bridge's touchend: a plain tap that resolves to a highlight opens the RN
  // edit modal (recolor/delete) INSTEAD of toggling the immersive bars (L4).
  // Reverse order → topmost-painted rect wins on overlap.
  ;(window as unknown as { __pdfHighlightAtPoint: (x: number, y: number) => string | null }).__pdfHighlightAtPoint = (
    x: number,
    y: number,
  ) => {
    const rects = document.querySelectorAll('.pdf-hl-rect')
    for (let i = rects.length - 1; i >= 0; i--) {
      const el = rects[i] as HTMLElement
      const r = el.getBoundingClientRect()
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return el.dataset.highlightId || null
      }
    }
    return null
  }

  // Inbound: RN commits a highlight for the CURRENT selection (user tapped the
  // toolbar Highlight button; color is chosen RN-side). We resolve the anchor
  // from the live selection and post it back for persistence, then drop the
  // native selection so the new highlight isn't left visibly selected.
  ;(window as unknown as { __pdfCreateHighlight: () => void }).__pdfCreateHighlight = () => {
    try {
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed || !sel.rangeCount) return
      const range = sel.getRangeAt(0)
      const anchor = computeAnchorFromRange(range)
      if (anchor && anchor.rects.length > 0) post({ type: 'pdfHighlightCreate', anchor })
      try { sel.removeAllRanges() } catch { /* noop */ }
    } catch (e) {
      console.warn('[pdf] create highlight failed', (e as Error)?.message)
    }
  }

  // Re-scale on rotation / resize.
  let resizeRaf = 0
  window.addEventListener('resize', () => {
    if (resizeRaf) return
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0
      const next = computeScale()
      if (Math.abs(next - scale) < 0.001) return
      applyPlaceholderSizes(next)
      // Force redraw of on-screen pages at the new scale.
      states.forEach((st) => { if (st.drawnScale !== null) freePage(st) })
      syncRings()
    })
  })

  void loadDocument(0)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', main)
} else {
  main()
}
