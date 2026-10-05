import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePdfDocument } from '../../hooks/usePdfDocument'
import { useTranslation } from '../../hooks/useTranslation'
import { refreshToken } from '../../api/auth'
import { PdfPage } from './PdfPage'
import { PdfHighlightPopup } from './PdfHighlightPopup'
import { hitTestHighlightRects, hasActiveSelection } from './PdfHighlightLayer'
import type { HighlightColor, StoredHighlight } from '../../lib/offlineDb'
import {
  clampPage,
  computePageRings,
  dimsReadyUpTo,
  resolveOpenPage,
  topVisiblePage,
  buildPdfProgressPayload,
} from '@textstack/shared'
import { readPdfPage, writePdfPage } from '../../lib/originalLayoutPref'
import { saveUserBookProgress } from '../../api/userBooks'
import { pageAtViewportTop, type PageRect } from '../../lib/pdfPageAtTop'
import '../../styles/pdfOriginal.css'

interface PageDim {
  w: number
  h: number
}

interface PdfOriginalViewProps {
  fileUrl: string
  bookId: string
  /**
   * 1-based PDF page to open at (current chapter's sourceStartPage). When set it
   * WINS over the persisted resume page — the user chose this chapter. Null when
   * the chapter carries no page, in which case the resume page is used.
   */
  initialPage: number | null
  /**
   * Server-persisted resume page (parsed from the `page:<N>` progress locator).
   * Used when the chapter carries no page — it WINS over the localStorage resume
   * page (cross-device). Null when there is no server progress yet.
   */
  resumePage?: number | null
  /**
   * False while the server resume page is still being fetched. The initial
   * scroll waits for this so a cross-device open lands on the server page rather
   * than page 1. Ignored when `initialPage` is set (chapter jump is instant).
   */
  resumeReady?: boolean
  /** TOC-driven jump. Nonce lets the same page be re-targeted. */
  scrollToPage: { page: number; nonce: number } | null
  /**
   * Fired (deduped) whenever the top-visible page changes. Lets the reader track
   * the current page for the top-bar page-bookmark toggle + page bookmarks.
   */
  onPageChange?: (page: number) => void
  /** Fired when pdf.js reports the document's page count. Lets the reader clamp page jumps. */
  onNumPages?: (numPages: number) => void
  /**
   * Fired (throttled) on genuine reading scroll so the reader can keep the
   * reading SESSION alive (time / streak / goals). Deliberately time-only — we
   * never feed a page-based percent into word-based server progress.
   */
  onActivity?: () => void
  /**
   * Fired when pdf.js hard-fails to open the document (corrupt / unreadable) —
   * NOT the internal 401 session-expired path, which reloads in place. Lets the
   * reader fall back to reflow (if chapters exist) or a "can't open" screen.
   */
  onLoadError?: (message: string) => void
  /**
   * Persistent text highlights for this book (lifted to ReaderPage so create —
   * owned by the single SelectionToolbar in ReaderHighlights — and paint/edit
   * share one hook). The view paints them per page + owns the edit popup.
   */
  highlights?: StoredHighlight[]
  /** Recolor / note edit — forwarded to the lifted highlights hook. */
  onHighlightUpdate?: (
    id: string,
    updates: { color?: HighlightColor; noteText?: string | null },
  ) => void | Promise<unknown>
  /** Delete — forwarded to the lifted highlights hook. */
  onHighlightDelete?: (id: string) => void | Promise<unknown>
}

const MIN_SCALE = 0.2
const MAX_SCALE = 5
const FALLBACK_DIM: PageDim = { w: 612, h: 792 } // US Letter @72dpi
const ACTIVITY_THROTTLE_MS = 1500
const SCROLL_SUPPRESS_MS = 250
const SERVER_PROGRESS_DEBOUNCE_MS = 2000

/** 401/403-ish rejection from a lazy Range request after the token expired. */
function isAuthError(err: unknown): boolean {
  const status = (err as { status?: number })?.status
  if (status === 401 || status === 403) return true
  const e = err as { message?: string; name?: string }
  return /401|403|unauthor|forbidden/i.test(`${e?.message || ''} ${e?.name || ''}`)
}

/**
 * Renders a user book's ORIGINAL PDF pixel-perfect (canvas + selectable text
 * layer) as an opt-in alternative to the reflow reader. Whole book = one
 * document. Scrolls internally; the page position is persisted BOTH to
 * localStorage (instant resume) and to server progress as a page fraction
 * (ADR-012 S2) so the library card shows a % and resume works cross-device. It
 * never mixes with the reflow reader's word-based percent — a chapterless PDF
 * simply owns the same ProgressPercent field via a page-based fraction.
 *
 * Default export — imported via React.lazy so pdfjs is a separate async chunk.
 */
export default function PdfOriginalView({
  fileUrl,
  bookId,
  initialPage,
  resumePage = null,
  resumeReady = true,
  scrollToPage,
  onPageChange,
  onNumPages,
  onActivity,
  onLoadError,
  highlights,
  onHighlightUpdate,
  onHighlightDelete,
}: PdfOriginalViewProps) {
  const [reloadToken, setReloadToken] = useState(0)
  const { pdf, numPages, loading, error } = usePdfDocument(fileUrl, reloadToken)
  const { t } = useTranslation()

  const scrollRef = useRef<HTMLDivElement>(null)
  const observerRef = useRef<IntersectionObserver | null>(null)
  const pageEls = useRef<Map<number, HTMLElement>>(new Map())
  const didInitialScrollRef = useRef(false)
  const userInteractedRef = useRef(false)
  const suppressIntentUntilRef = useRef(0)
  const pendingTargetRef = useRef<number | null>(null)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const serverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPageRef = useRef<number | null>(null)
  const numPagesRef = useRef(numPages)
  const lastActivityRef = useRef(0)
  const onActivityRef = useRef(onActivity)
  const onPageChangeRef = useRef(onPageChange)
  const lastReportedPageRef = useRef<number | null>(null)
  const prevPdfRef = useRef<typeof pdf>(null)
  const reloadTargetRef = useRef<number | null>(null)

  const [pageDims, setPageDims] = useState<(PageDim | undefined)[]>([])
  const [visible, setVisible] = useState<Set<number>>(new Set())
  const [containerWidth, setContainerWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [invert, setInvert] = useState(false)
  const [pageInput, setPageInput] = useState('')
  const [sessionExpired, setSessionExpired] = useState(false)
  // Highlight edit popup (recolor / note / delete). Rect captured at click time.
  const [editHl, setEditHl] = useState<{ highlight: StoredHighlight; rect: DOMRect } | null>(null)

  useEffect(() => {
    onActivityRef.current = onActivity
  }, [onActivity])

  useEffect(() => {
    onPageChangeRef.current = onPageChange
  }, [onPageChange])

  useEffect(() => {
    numPagesRef.current = numPages
  }, [numPages])

  // Surface the page count so the reader can clamp page jumps at the source.
  const onNumPagesRef = useRef(onNumPages)
  useEffect(() => {
    onNumPagesRef.current = onNumPages
  }, [onNumPages])
  useEffect(() => {
    if (numPages > 0) onNumPagesRef.current?.(numPages)
  }, [numPages])

  // Precedence: chapter page (user chose it) > server resume page > localStorage
  // resume page > 1. resolveOpenPage takes the first real (>=1) candidate.
  const openPage = useMemo(
    () => resolveOpenPage(initialPage, resumePage, readPdfPage(bookId)),
    [bookId, initialPage, resumePage],
  )

  // The page under the top of the scroll viewport. `visible` is the RENDER set
  // (300px rootMargin) and its lowest page is often the one above — persisting
  // that made every open land one page earlier (C3). It stays the fallback only
  // until the first measurement.
  const [topPage, setTopPage] = useState<number | null>(null)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const measureTopPage = useCallback(() => {
    const root = scrollRef.current
    if (!root) return
    const rects: PageRect[] = []
    for (const pn of visibleRef.current) {
      const el = pageEls.current.get(pn)
      if (!el) continue
      const r = el.getBoundingClientRect()
      rects.push({ page: pn, top: r.top, bottom: r.bottom })
    }
    const pn = pageAtViewportTop(rects, root.getBoundingClientRect().top)
    if (pn != null) setTopPage(pn)
  }, [])
  const currentPage = topPage ?? topVisiblePage(visible, openPage)

  // Surface the current page to the reader (deduped) once real pages are on
  // screen. Gated on visible.size so the initial openPage guess doesn't fire
  // before the IntersectionObserver has reported anything.
  useEffect(() => {
    if (!visible.size) return
    if (lastReportedPageRef.current === currentPage) return
    lastReportedPageRef.current = currentPage
    onPageChangeRef.current?.(currentPage)
  }, [currentPage, visible.size])

  // --- Load every page's unscaled viewport up front (cheap metadata) so
  // placeholder heights are stable and scroll height doesn't jump. ---
  useEffect(() => {
    if (!pdf) return
    let cancelled = false
    setPageDims(new Array(pdf.numPages).fill(undefined))
    ;(async () => {
      // Accumulate locally and flush in chunks — one setState per page would
      // re-render the whole page list N times (O(n²) reconciliation on load).
      const dims: (PageDim | undefined)[] = new Array(pdf.numPages).fill(undefined)
      const flush = () => { if (!cancelled) setPageDims(dims.slice()) }
      for (let i = 1; i <= pdf.numPages; i++) {
        try {
          const page = await pdf.getPage(i)
          if (cancelled) return
          const vp = page.getViewport({ scale: 1 })
          dims[i - 1] = { w: vp.width, h: vp.height }
          if (i % 20 === 0) flush() // periodic so early placeholders firm up
        } catch {
          if (cancelled) return
        }
      }
      flush()
    })()
    return () => {
      cancelled = true
    }
  }, [pdf])

  // --- Measure the scroll container width for fit-width scaling. ---
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () => setContainerWidth(el.clientWidth)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [pdf, sessionExpired])

  const baseDim = pageDims[0] ?? FALLBACK_DIM
  const fitScale = containerWidth > 0 ? (containerWidth - 24) / baseDim.w : 1
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, fitScale * zoom))

  const rings = useMemo(() => computePageRings(visible, numPages), [visible, numPages])

  // --- IntersectionObserver: track which pages are on screen. ---
  useEffect(() => {
    const root = scrollRef.current
    if (!root || !numPages) return
    const obs = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev)
          for (const e of entries) {
            const pn = Number((e.target as HTMLElement).dataset.page)
            if (!pn) continue
            if (e.isIntersecting) next.add(pn)
            else next.delete(pn)
          }
          return next
        })
      },
      { root, rootMargin: '300px 0px' },
    )
    observerRef.current = obs
    pageEls.current.forEach((el) => obs.observe(el))
    return () => {
      obs.disconnect()
      observerRef.current = null
    }
  }, [numPages])

  // Cache one registrar per page so its identity is STABLE across renders —
  // otherwise a fresh ref callback each render makes React unobserve/observe on
  // every scroll frame and defeats PdfPage's React.memo.
  const registrarsRef = useRef<Map<number, (el: HTMLElement | null) => void>>(new Map())
  const registerPage = useCallback((pn: number) => {
    let fn = registrarsRef.current.get(pn)
    if (!fn) {
      fn = (el: HTMLElement | null) => {
        const map = pageEls.current
        const prev = map.get(pn)
        if (prev && observerRef.current) observerRef.current.unobserve(prev)
        if (el) {
          map.set(pn, el)
          observerRef.current?.observe(el)
        } else {
          map.delete(pn)
        }
      }
      registrarsRef.current.set(pn, fn)
    }
    return fn
  }, [])

  const scrollToPageEl = useCallback((pn: number) => {
    const el = pageEls.current.get(pn)
    const root = scrollRef.current
    if (!el || !root) return
    // Scroll ONLY the internal container. Mark a short suppression window so the
    // resulting `scroll` event isn't misread as user intent (which would cancel
    // the correction pass).
    suppressIntentUntilRef.current = Date.now() + SCROLL_SUPPRESS_MS
    root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top
  }, [])

  // Any jump (initial open / TOC / page-input / reload) goes through here so it
  // clamps to [1, numPages] and re-aligns once heights above the target settle.
  const jumpToPage = useCallback(
    (raw: number) => {
      const target = clampPage(raw, numPages)
      pendingTargetRef.current = target
      userInteractedRef.current = false
      scrollToPageEl(target)
    },
    [numPages, scrollToPageEl],
  )

  // --- Detect genuine user scroll (incl. scrollbar drag, which fires `scroll`
  // but not wheel/touch) + keep the reading session alive. Programmatic
  // scrolls are ignored via the suppression window. ---
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    let frame = 0
    const onScroll = () => {
      // Every scroll, programmatic jumps included, moves the top-line page.
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; measureTopPage() })
      if (Date.now() < suppressIntentUntilRef.current) return
      userInteractedRef.current = true
      const now = Date.now()
      if (now - lastActivityRef.current > ACTIVITY_THROTTLE_MS) {
        lastActivityRef.current = now
        onActivityRef.current?.()
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      el.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(frame)
    }
  }, [pdf, measureTopPage])

  // Layout changes without a scroll (pages entering the render set, heights
  // streaming in, zoom) also move what sits under the top line.
  useEffect(() => {
    measureTopPage()
  }, [visible, pageDims, scale, measureTopPage])

  // --- Initial scroll to the open page (once the document is ready). When the
  // chapter carries no page we wait for the server resume answer (resumeReady)
  // so a cross-device open lands on the saved page, not page 1. A chapter jump
  // (initialPage set) never waits — it's authoritative and instant. ---
  useEffect(() => {
    if (!pdf || didInitialScrollRef.current) return
    if (initialPage == null && !resumeReady) return
    didInitialScrollRef.current = true
    requestAnimationFrame(() => jumpToPage(openPage))
  }, [pdf, openPage, initialPage, resumeReady, jumpToPage])

  // --- One-shot correction for ANY pending jump: re-align once placeholder
  // heights above the target have streamed in and the user hasn't scrolled. ---
  useEffect(() => {
    const target = pendingTargetRef.current
    if (target == null) return
    if (userInteractedRef.current) {
      pendingTargetRef.current = null
      return
    }
    if (dimsReadyUpTo(pageDims, target)) {
      requestAnimationFrame(() => scrollToPageEl(target))
      pendingTargetRef.current = null
    }
  }, [pageDims, scrollToPageEl])

  // --- TOC jump (scroll-to-page, not route navigation). ---
  useEffect(() => {
    if (!scrollToPage) return
    jumpToPage(scrollToPage.page)
  }, [scrollToPage, jumpToPage])

  // --- After a session-expired reload lands a fresh document, restore the page. ---
  useEffect(() => {
    if (pdf && pdf !== prevPdfRef.current && reloadTargetRef.current != null) {
      const target = reloadTargetRef.current
      reloadTargetRef.current = null
      requestAnimationFrame(() => jumpToPage(target))
    }
    prevPdfRef.current = pdf
  }, [pdf, jumpToPage])

  // Flush the latest page position to server progress (page fraction → the same
  // ProgressPercent field the library card reads). Idempotent upsert; failures
  // are logged only so reading is never interrupted. Reused for the debounce
  // timer, tab-hide, and unmount.
  const flushServerProgress = useCallback(() => {
    if (serverTimerRef.current) {
      clearTimeout(serverTimerRef.current)
      serverTimerRef.current = null
    }
    const page = pendingPageRef.current
    const np = numPagesRef.current
    if (page == null || !bookId || np < 1) return
    pendingPageRef.current = null
    saveUserBookProgress(bookId, buildPdfProgressPayload(page, np)).catch((err) => {
      console.warn('[progress] pdf save failed', err)
    })
  }, [bookId])

  // --- Persist current page for resume: localStorage (instant, offline-safe)
  // plus server progress (debounced ~2s) so the library card shows a % and
  // resume works cross-device. Both write the SAME page — no double-counting. ---
  useEffect(() => {
    if (!visible.size) return
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    persistTimerRef.current = setTimeout(() => writePdfPage(bookId, currentPage), 500)

    pendingPageRef.current = currentPage
    if (serverTimerRef.current) clearTimeout(serverTimerRef.current)
    serverTimerRef.current = setTimeout(flushServerProgress, SERVER_PROGRESS_DEBOUNCE_MS)

    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    }
  }, [currentPage, visible.size, bookId, flushServerProgress])

  // --- Flush pending server progress on tab-hide + unmount (mirrors the reflow
  // reader) so the last page isn't lost when the reader closes. ---
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushServerProgress()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('beforeunload', flushServerProgress)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('beforeunload', flushServerProgress)
      flushServerProgress()
      if (serverTimerRef.current) clearTimeout(serverTimerRef.current)
    }
  }, [flushServerProgress])

  // Surface a hard document-load failure (corrupt / unreadable PDF, or an
  // unrecoverable error after usePdfDocument's one retry) to the parent so it
  // can fall back to reflow or show a "can't open" screen. The per-page 401
  // recovery below (sessionExpired banner) is separate and untouched.
  const loadErrorFiredRef = useRef(false)
  useEffect(() => {
    if (!error) {
      loadErrorFiredRef.current = false
      return
    }
    if (loadErrorFiredRef.current) return
    loadErrorFiredRef.current = true
    onLoadError?.(error)
  }, [error, onLoadError])

  const handlePageError = useCallback((err: unknown) => {
    if (isAuthError(err)) setSessionExpired(true)
  }, [])

  const handleReload = useCallback(async () => {
    reloadTargetRef.current = currentPage
    setSessionExpired(false)
    try {
      await refreshToken()
    } catch {
      /* range requests re-auth via the fresh cookie; ignore refresh failures */
    }
    setReloadToken((n) => n + 1)
  }, [currentPage])

  // Click-to-edit via hit-testing (M2). The highlight rects are
  // `pointer-events: none` so a selection can start/drag over them; on a plain
  // click (no active selection) we find the topmost painted `.pdf-hl-rect` under
  // the point and open its edit popup. A drag-select ends with a click too, so
  // the active-selection guard hands that gesture to the SelectionToolbar.
  const handlePagesClick = useCallback(
    (e: React.MouseEvent) => {
      if (!(onHighlightUpdate || onHighlightDelete)) return
      if (hasActiveSelection(window.getSelection())) return
      const root = scrollRef.current
      if (!root) return
      const hits = Array.from(root.querySelectorAll<HTMLElement>('.pdf-hl-rect'))
        .map((el) => ({ id: el.dataset.highlightId ?? '', box: el.getBoundingClientRect() }))
        .filter((h) => h.id)
      const hit = hitTestHighlightRects(hits, e.clientX, e.clientY)
      if (!hit) return
      const highlight = highlights?.find((h) => h.id === hit.id)
      if (highlight) setEditHl({ highlight, rect: hit.box })
    },
    [highlights, onHighlightUpdate, onHighlightDelete],
  )

  // Reflect live edits (recolor) while the popup stays open — resolve the freshest
  // copy from the highlights array by id, falling back to the captured snapshot.
  const activeEditHl = editHl
    ? (highlights?.find((h) => h.id === editHl.highlight.id) ?? editHl.highlight)
    : null

  const handleFitWidth = () => setZoom(1)
  const handleZoomIn = () => setZoom((z) => Math.min(4, z * 1.2))
  const handleZoomOut = () => setZoom((z) => Math.max(0.25, z / 1.2))
  const handlePageJump = (e: React.FormEvent) => {
    e.preventDefault()
    const n = parseInt(pageInput, 10)
    if (Number.isFinite(n)) jumpToPage(n) // clampPage handles overflow
    setPageInput('')
  }

  if (error) {
    return (
      <div className="pdf-original">
        <div className="pdf-original__error">{t('reader.originalLayout.error')}</div>
      </div>
    )
  }

  return (
    <div className="pdf-original">
      <div className="pdf-original__toolbar">
        <button type="button" className="pdf-original__btn" onClick={handleFitWidth} title={t('reader.originalLayout.fitWidth')}>
          {t('reader.originalLayout.fit')}
        </button>
        <button type="button" className="pdf-original__btn" onClick={handleZoomOut} title={t('reader.originalLayout.zoomOut')} aria-label={t('reader.originalLayout.zoomOut')}>
          −
        </button>
        <button type="button" className="pdf-original__btn" onClick={handleZoomIn} title={t('reader.originalLayout.zoomIn')} aria-label={t('reader.originalLayout.zoomIn')}>
          +
        </button>
        <form onSubmit={handlePageJump} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input
            className="pdf-original__page-input"
            inputMode="numeric"
            value={pageInput}
            placeholder={String(currentPage)}
            onChange={(e) => setPageInput(e.target.value.replace(/\D/g, ''))}
            aria-label={t('reader.originalLayout.goToPage')}
          />
          <span className="pdf-original__page-count">/ {numPages || '…'}</span>
        </form>
        <span className="pdf-original__toolbar-spacer" />
        <button
          type="button"
          className={`pdf-original__btn${invert ? ' pdf-original__btn--active' : ''}`}
          onClick={() => setInvert((v) => !v)}
          title={t('reader.originalLayout.dimToggle')}
          aria-pressed={invert}
        >
          {t('reader.originalLayout.dim')}
        </button>
      </div>

      {sessionExpired && (
        <div className="pdf-original__banner" role="alert">
          <span>{t('reader.originalLayout.sessionExpired')}</span>
          <button type="button" className="pdf-original__btn" onClick={handleReload}>
            {t('reader.originalLayout.reload')}
          </button>
        </div>
      )}

      {loading && !pdf ? (
        <div className="pdf-original__loading">{t('reader.originalLayout.loading')}</div>
      ) : (
        <div className="pdf-original__scroll" ref={scrollRef}>
          {/* data-scale is read by computePdfAnchorFromRange to convert a live
              selection's client rects into unscaled page-relative anchor coords.
              onClick hit-tests the painted (pointer-events:none) highlight rects
              for click-to-edit — see handlePagesClick. */}
          <div className="pdf-original__pages" data-scale={scale} onClick={handlePagesClick}>
            {pdf &&
              Array.from({ length: numPages }, (_, i) => {
                const pn = i + 1
                const dim = pageDims[i] ?? pageDims[0] ?? FALLBACK_DIM
                return (
                  <PdfPage
                    key={pn}
                    pdf={pdf}
                    pageNumber={pn}
                    scale={scale}
                    render={rings.render.has(pn)}
                    keep={rings.keep.has(pn)}
                    invert={invert}
                    cssWidth={Math.round(dim.w * scale)}
                    cssHeight={Math.round(dim.h * scale)}
                    registerRef={registerPage(pn)}
                    onLoadError={handlePageError}
                    highlights={highlights}
                  />
                )
              })}
          </div>
        </div>
      )}

      {activeEditHl && editHl && (
        <PdfHighlightPopup
          highlight={activeEditHl}
          rect={editHl.rect}
          containerRef={scrollRef}
          onRecolor={(color) => onHighlightUpdate?.(activeEditHl.id, { color })}
          onNoteSave={(noteText) => onHighlightUpdate?.(activeEditHl.id, { noteText })}
          onDelete={() => {
            onHighlightDelete?.(activeEditHl.id)
            setEditHl(null)
          }}
          onClose={() => setEditHl(null)}
        />
      )}
    </div>
  )
}
