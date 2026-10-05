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
  let appliedJumpId = 0
  let lastReportedPage = -1
  let lastPageReportAt = 0
  let reportTimer: ReturnType<typeof setTimeout> | null = null
  const openPage = resolveOpenPage(cfg.initialPage)

  function containerWidth(): number {
    return window.innerWidth || document.documentElement.clientWidth || 360
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

  function applyPlaceholderSizes(): void {
    states.forEach((st, pn) => {
      const box = pageBox(pn)
      st.el.style.width = box.w + 'px'
      st.el.style.height = box.h + 'px'
    })
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
    // ponytail: O(numPages) rect reads per throttled report; binary-search the
    // page column if a huge PDF ever shows up in a scroll profile.
    const rects: PageRect[] = []
    states.forEach((st, pn) => {
      const r = st.el.getBoundingClientRect()
      rects.push({ page: pn, top: r.top, bottom: r.bottom })
    })
    return pageAtViewportTop(rects, 0) ?? topVisiblePage(visible, openPage)
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
    scrollToPageEl(target)
  }

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
        if (i === 1) {
          // First real dim → recompute scale + placeholder sizes.
          scale = computeScale()
          applyPlaceholderSizes()
        }
        if (i % 10 === 0) applyPlaceholderSizes()
      } catch {
        /* keep fallback dim */
      }
      // One correction path for both the boot seed and every RN jump. Heights
      // stream in lazily, so a jump issued before the pages above the target are
      // measured lands in the wrong place and has to be redone once they are.
      if (pendingTarget != null && dimsReadyUpTo(pageDims, pendingTarget)) {
        const t = pendingTarget
        const id = pendingJumpId
        pendingTarget = null
        pendingJumpId = 0
        applyPlaceholderSizes()
        requestAnimationFrame(() => {
          scrollToPageEl(t)
          appliedJumpId = id
          // Tell RN this jump landed. Position alone is ambiguous — the page it
          // would report may be the one it already reported — so the id travels.
          reportTopPageNow()
        })
      }
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
      scale = computeScale()
      applyPlaceholderSizes()
      observeAll()
      // Seed the one target variable. `pendingTarget` may already hold a page RN
      // asked for before the document finished opening — that request is newer
      // and more specific, so it wins. This ordering is the fix: the seed used to
      // be a separate self-jump that overwrote RN's request instead.
      if (pendingTarget == null && openPage > 1) pendingTarget = clampPage(openPage, numPages)
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
      scale = next
      applyPlaceholderSizes()
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
