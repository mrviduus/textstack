import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createEngine, pdfAnchorToLocator, type ChapterDoc, type Locator, type ReaderEngine } from '@textstack/reader-engine'
import { buildPdfProgressPayload, isPdfAnchor, pdfGateReduce, PDF_GATE_INITIAL, resolveOpenPage } from '@textstack/shared'
import { useTranslation } from '../../hooks/useTranslation'
import { refreshToken } from '../../api/auth'
import { saveUserBookProgress } from '../../api/userBooks'
import { readPdfPage, writePdfPage } from '../../lib/originalLayoutPref'
import { openPdfSource } from '../../lib/pdfRangeSource'
import { setMountedEngine, unmountEngine } from '../../lib/readerEngine'
import { useNewerPositionCheck } from '../../hooks/useNewerPositionCheck'
import type { HighlightColor, StoredHighlight } from '../../lib/offlineDb'
import { PdfHighlightPopup } from './PdfHighlightPopup'
import { COLOR_MAP } from './PdfHighlightLayer'
import { isReviewed, useReviewedMarks } from './ReviewedMarks'
import { isReaderScrollKey, pdfFixedLayout } from './pdfEngineLayout'
import '../../styles/pdfOriginal.css'

interface Props {
  fileUrl: string
  bookId: string
  /** The chapter's start page: wins over every resume page (the reader chose the chapter). */
  initialPage: number | null
  /** The server's `page:<N>`, only when provably newer than this device's. */
  resumePage?: number | null
  /** False while the server's answer is pending: a chapterless open waits for it. */
  resumeReady?: boolean
  /** No server answer: open at this device's page and save nothing until the reader moves. */
  resumeUnanswered?: boolean
  fetchNewerPage?: (signal: AbortSignal) => Promise<number | false | null>
  /** TOC / bookmark / highlight jump; the nonce re-targets the same page. */
  scrollToPage: { page: number; nonce: number } | null
  onPageChange?: (page: number) => void
  onNumPages?: (numPages: number) => void
  /** Time-only reading activity (session / streak), never a percent. */
  onActivity?: () => void
  /** The PDF cannot be opened: the reader falls back to reflow or a "can't open" screen. */
  onLoadError?: (message: string) => void
  /** A tap on the page (not on a highlight): shows the reader's bars. */
  onTap?: () => void
  /** The engine's slot name while mounted (`mountedEngineFor`), null after: ReaderHighlights takes its selection. */
  onEngine?: (href: string | null) => void
  highlights?: StoredHighlight[]
  onHighlightUpdate?: (id: string, updates: { color?: HighlightColor; noteText?: string | null }) => void | Promise<unknown>
  onHighlightDelete?: (id: string) => void | Promise<unknown>
}

type PdfSource = NonNullable<ChapterDoc['pdf']>

const ACTIVITY_THROTTLE_MS = 1500
const SERVER_PROGRESS_DEBOUNCE_MS = 2000
const LOCAL_DEBOUNCE_MS = 500
/** The reader's fixed top bar (reader.css `.reader-top-bar`). */
const TOP_BAR_PX = 56
const at = (page: number): Locator => ({ type: 'application/pdf', locations: { position: page } })

/**
 * The Original-layout PDF through the reader engine's fixed layout (ADR-025 Phase 5 slice 3,
 * READER_ENGINE_PDF). The engine draws the pages, keeps the place, zooms, selects and paints; this host
 * brings the bytes (cookie, ranges, 401 retry), decides where to open, and saves the page the reader is
 * on — through the same ADR-012 gate as PdfOriginalView, fed by the engine's acks. Window scroll (answer 5a).
 *
 * Default export — behind React.lazy, so pdf.js stays a lazy chunk.
 */
export default function PdfEngineView({
  fileUrl,
  bookId,
  initialPage,
  resumePage = null,
  resumeReady = true,
  resumeUnanswered = false,
  fetchNewerPage,
  scrollToPage,
  onPageChange,
  onNumPages,
  onActivity,
  onLoadError,
  onTap,
  onEngine,
  highlights,
  onHighlightUpdate,
  onHighlightDelete,
}: Props) {
  const { t } = useTranslation()
  const wrapRef = useRef<HTMLDivElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const toolbarRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<ReaderEngine | null>(null)
  const cb = useRef({ onPageChange, onNumPages, onActivity, onLoadError, onTap, onEngine, highlights })
  cb.current = { onPageChange, onNumPages, onActivity, onLoadError, onTap, onEngine, highlights }

  const [source, setSource] = useState<PdfSource | null>(null)
  const [sourceKey, setSourceKey] = useState(0)
  const [numPages, setNumPages] = useState(0)
  const [page, setPage] = useState<number | null>(null)
  const [zoom, setZoom] = useState(1)
  const [invert, setInvert] = useState(false)
  const [pageInput, setPageInput] = useState('')
  const [sessionExpired, setSessionExpired] = useState(false)
  const [failed, setFailed] = useState(false)
  const [pendingJump, setPendingJump] = useState<number | null>(null)
  const [editHl, setEditHl] = useState<{ highlight: StoredHighlight; rect: DOMRect } | null>(null)
  const [opened, setOpened] = useState(false)

  // Is the page on screen one the reader chose? Closed from an open until its ack (pdfPersistGate).
  const gateRef = useRef(PDF_GATE_INITIAL)
  const jumpSeqRef = useRef(0)
  /** The engine and bytes the current document was opened with (StrictMode makes a second engine, Reload new bytes). */
  const openedForRef = useRef<{ engine: ReaderEngine; source: PdfSource } | null>(null)
  /** The open's document is in (`ready`): a later 'pdf-load' is one failed read, not a reason to fall back. */
  const docReadyRef = useRef(false)
  /** Reopen here after a session-expired reload. */
  const reloadPageRef = useRef<number | null>(null)
  // Don't save the page on screen until the reader moves (an unanswered open, a newer-page move).
  const holdRef = useRef(false)
  // The reader moved by themselves since the last jump or tab hide.
  const movedRef = useRef(false)
  // The page on screen was chosen (chapter, TOC, highlight): a newer page elsewhere never replaces it.
  const explicitRef = useRef(false)
  const currentPageRef = useRef<number | null>(null)
  const numPagesRef = useRef(0)
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const serverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingPageRef = useRef<number | null>(null)
  const lastActivityRef = useRef(0)
  const loadErrorFiredRef = useRef(false)

  /** The reader moved by themselves: a hold may end, a newer page no longer moves them; the session is alive. */
  const readerMoved = useCallback(() => {
    movedRef.current = true
    explicitRef.current = false
    const now = Date.now()
    if (now - lastActivityRef.current > ACTIVITY_THROTTLE_MS) {
      lastActivityRef.current = now
      cb.current.onActivity?.()
    }
  }, [])

  const openPage = useMemo(() => resolveOpenPage(initialPage, resumePage, readPdfPage(bookId)), [bookId, initialPage, resumePage])

  /** Every open / goTo is a jump: the gate waits for its ack before a page is saved. */
  const jump = useCallback((page: number, run: (opId: string) => unknown) => {
    const id = ++jumpSeqRef.current
    gateRef.current = pdfGateReduce(gateRef.current, { type: 'jumpIssued', page, jumpId: id, at: Date.now() }).state
    movedRef.current = false
    void run(String(id))
  }, [])

  const goToPage = useCallback((page: number) => {
    const engine = engineRef.current
    if (engine) jump(page, (opId) => engine.goTo(at(page), { opId }))
  }, [jump])

  const flushServerProgress = useCallback(() => {
    if (serverTimerRef.current) {
      clearTimeout(serverTimerRef.current)
      serverTimerRef.current = null
    }
    const p = pendingPageRef.current
    const np = numPagesRef.current
    if (p == null || !bookId || np < 1) return
    pendingPageRef.current = null
    // One stamp for both records, so this device's own write never reads back as newer.
    const stamp = Date.now()
    writePdfPage(bookId, p, stamp)
    saveUserBookProgress(bookId, buildPdfProgressPayload(p, np, stamp)).catch((err) => {
      console.warn('[progress] pdf save failed', err)
    })
  }, [bookId])

  const flushRef = useRef(flushServerProgress)
  flushRef.current = flushServerProgress

  // --- The engine: one per mounted view. Its events are the only page source. ---
  useEffect(() => {
    const engine = createEngine(rootRef.current!, { fixed: pdfFixedLayout })
    engineRef.current = engine
    const href = `pdf:${bookId}`
    setMountedEngine({ engine, href })
    const offs = [
      engine.on('ready', ({ pageCount }) => {
        docReadyRef.current = true
        if (!pageCount) return
        numPagesRef.current = pageCount
        setNumPages(pageCount)
        cb.current.onNumPages?.(pageCount)
      }),
      engine.on('relocated', ({ locator, reason, opId }) => {
        const n = locator.locations.position
        // Before this engine's open (the insets' 'style' ack): no page yet.
        if (openedForRef.current?.engine !== engine) return
        // A superseded op acks with its own opId at the NEW target: not a landing, not the reader's page.
        if (!n || (opId && Number(opId) !== jumpSeqRef.current)) return
        if (reason === 'scroll') readerMoved()   // a scrollbar drag too
        currentPageRef.current = n
        setPage(n)
        const gate = pdfGateReduce(gateRef.current, { type: 'pageReported', page: n, ackJumpId: opId ? Number(opId) : undefined, at: Date.now() })
        gateRef.current = gate.state
        if (!gate.persist) return
        if (holdRef.current) {
          if (!movedRef.current) return
          holdRef.current = false
        }
        if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
        persistTimerRef.current = setTimeout(() => writePdfPage(bookId, n), LOCAL_DEBOUNCE_MS)
        pendingPageRef.current = n
        if (serverTimerRef.current) clearTimeout(serverTimerRef.current)
        serverTimerRef.current = setTimeout(() => flushRef.current(), SERVER_PROGRESS_DEBOUNCE_MS)
      }),
      engine.on('error', ({ code, detail }) => {
        if (code === 'pdf-auth') setSessionExpired(true)
        else if (code === 'pdf-load') {
          if (docReadyRef.current) return console.warn('[pdf] a read failed after the open', detail)
          setFailed(true)
          if (!loadErrorFiredRef.current) {
            loadErrorFiredRef.current = true
            cb.current.onLoadError?.(detail ?? code)
          }
        }
      }),
      engine.on('tap', () => cb.current.onTap?.()),
      engine.on('decorationTap', ({ group, id, rect }) => {
        const h = group === 'highlight' && cb.current.highlights?.find((x) => x.id === id)
        if (h) setEditHl({ highlight: h, rect: new DOMRect(rect.x, rect.y, rect.width, rect.height) })
      }),
    ]
    // E42: pages land clear of the top bar and the toolbar under it.
    engine.setStyle({ insets: { top: TOP_BAR_PX + (toolbarRef.current?.offsetHeight ?? 0), bottom: 0 } })
    cb.current.onEngine?.(href)
    return () => {
      offs.forEach((off) => off())
      cb.current.onEngine?.(null)
      unmountEngine(engine)
      engineRef.current = null
      engine.destroy()
    }
  }, [bookId, readerMoved])

  // --- The bytes: a length probe, then ranges (the engine reads them). Again after a reload. ---
  useEffect(() => {
    let off = false
    setSource(null)
    openPdfSource(fileUrl, { refresh: refreshToken }).then(
      (s) => { if (!off) setSource(s) },
      (e: unknown) => {
        if (off) return
        if ((e as { code?: string })?.code === 'pdf-auth') return setSessionExpired(true)
        console.warn('[pdf] the file could not be opened', e)
        setFailed(true)
        if (!loadErrorFiredRef.current) {
          loadErrorFiredRef.current = true
          cb.current.onLoadError?.((e as Error)?.message ?? 'pdf-load')
        }
      },
    )
    return () => { off = true }
  }, [fileUrl, sourceKey])

  // --- The open: once the bytes are there and the place is known. Precedence: a reload's page > a jump
  // asked for before the open > the chapter's page > the server's newer page > this device's page. A
  // chapterless open waits for the server's answer (resumeReady). ---
  useEffect(() => {
    const engine = engineRef.current
    if (!engine || !source || (openedForRef.current?.engine === engine && openedForRef.current.source === source)) return
    const reload = reloadPageRef.current
    if (reload == null && pendingJump == null && initialPage == null && !resumeReady) return
    let target: number
    if (reload != null) {
      target = reload
      reloadPageRef.current = null
    } else if (pendingJump != null) {
      target = pendingJump
      explicitRef.current = true
      holdRef.current = false
      setPendingJump(null)
    } else {
      target = openPage
      explicitRef.current = initialPage != null
      holdRef.current = resumeUnanswered && initialPage == null
    }
    openedForRef.current = { engine, source }
    docReadyRef.current = false
    gateRef.current = pdfGateReduce(gateRef.current, { type: 'documentLoaded' }).state
    jump(target, (opId) => engine.open({ layout: 'fixed', pdf: source }, at(target), opId))
    setOpened(true)
  }, [source, pendingJump, initialPage, resumeReady, resumeUnanswered, openPage, jump])

  // --- TOC / bookmark / highlight jump: once per nonce. Before the open, the open goes there. ---
  const appliedJumpRef = useRef<number | null>(null)
  useEffect(() => {
    if (!scrollToPage || appliedJumpRef.current === scrollToPage.nonce) return
    appliedJumpRef.current = scrollToPage.nonce
    explicitRef.current = true
    holdRef.current = false // the reader chose this page: it saves
    if (engineRef.current && openedForRef.current?.engine === engineRef.current) goToPage(scrollToPage.page)
    else setPendingJump(scrollToPage.page)
  }, [scrollToPage, goToPage])

  // The current page up to the reader (bookmark toggle), once per page.
  useEffect(() => {
    if (page != null) cb.current.onPageChange?.(page)
  }, [page])

  // --- Highlights painted by the engine from their stored rects; the reviewed dot after the last one. ---
  const reviewed = useReviewedMarks()
  useEffect(() => {
    engineRef.current?.decorate('highlight', (highlights ?? []).flatMap((h) => {
      if (!isPdfAnchor(h.anchor)) return []
      const locator = pdfAnchorToLocator(JSON.stringify(h.anchor))
      if (!locator) return []
      const fill = { id: h.id, locator, style: COLOR_MAP[h.color] }
      return isReviewed(reviewed, h.id) ? [fill, { id: h.id, locator, style: 'dot' }] : [fill]
    }))
  }, [highlights, reviewed])

  // --- The reader's own input, within a page too. Input, not `scroll`: the engine's own scrolls are not the reader. ---
  useEffect(() => {
    const onInput = (e: Event) => {
      if (e instanceof KeyboardEvent && !isReaderScrollKey(e)) return
      readerMoved()
    }
    const events = ['wheel', 'touchmove', 'keydown']
    events.forEach((e) => window.addEventListener(e, onInput, { passive: true }))
    return () => events.forEach((e) => window.removeEventListener(e, onInput))
  }, [readerMoved])

  // --- Another device's newer page (R4): after an unanswered open, and on every tab return. ---
  const checkNewerPage = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    if (!fetchNewerPage || !openedForRef.current) return false
    const p = await fetchNewerPage(signal)
    if (p === null || signal.aborted) return false
    if (p === false || explicitRef.current || movedRef.current) return true
    if (p === currentPageRef.current) return true
    holdRef.current = true // already the server's page: nothing to save until the reader moves
    pendingPageRef.current = null
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
    goToPage(p)
    return true
  }, [fetchNewerPage, goToPage])
  useNewerPositionCheck(fetchNewerPage ? checkNewerPage : undefined, { ready: opened, unanswered: resumeUnanswered, resetKey: bookId })

  useEffect(() => {
    // A hidden tab starts a fresh "has the reader moved" — not under a hold: that move is the reader's
    // only unsaved choice. And the last page goes to the server now.
    const onVisibility = () => {
      if (document.visibilityState !== 'hidden') return
      if (!holdRef.current) movedRef.current = false
      flushRef.current()
    }
    const onUnload = () => flushRef.current()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('beforeunload', onUnload)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('beforeunload', onUnload)
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current)
      flushRef.current()
    }
  }, [])

  const handleReload = useCallback(async () => {
    reloadPageRef.current = currentPageRef.current
    setSessionExpired(false)
    setFailed(false)
    loadErrorFiredRef.current = false
    try {
      await refreshToken()
    } catch {
      /* read() refreshes again on a 401 */
    }
    setSourceKey((k) => k + 1)
  }, [])

  const applyZoom = (z: number) => {
    setZoom(z)
    engineRef.current?.setStyle({ zoom: z })
  }
  const handlePageJump = (e: React.FormEvent) => {
    e.preventDefault()
    const n = parseInt(pageInput, 10)
    if (Number.isFinite(n)) {
      explicitRef.current = true
      holdRef.current = false
      goToPage(n) // the engine clamps
    }
    setPageInput('')
  }

  const activeEditHl = editHl ? (highlights?.find((h) => h.id === editHl.highlight.id) ?? editHl.highlight) : null

  return (
    <div ref={wrapRef} className={`pdf-engine${invert ? ' pdf-engine--invert' : ''}`}>
      <div ref={toolbarRef} className="pdf-original__toolbar pdf-engine__toolbar">
        <button type="button" className="pdf-original__btn" onClick={() => applyZoom(1)} title={t('reader.originalLayout.fitWidth')}>
          {t('reader.originalLayout.fit')}
        </button>
        <button type="button" className="pdf-original__btn" onClick={() => applyZoom(Math.max(0.25, zoom / 1.2))} title={t('reader.originalLayout.zoomOut')} aria-label={t('reader.originalLayout.zoomOut')}>
          −
        </button>
        <button type="button" className="pdf-original__btn" onClick={() => applyZoom(Math.min(4, zoom * 1.2))} title={t('reader.originalLayout.zoomIn')} aria-label={t('reader.originalLayout.zoomIn')}>
          +
        </button>
        <form onSubmit={handlePageJump} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <input
            className="pdf-original__page-input"
            inputMode="numeric"
            value={pageInput}
            placeholder={String(page ?? '')}
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
      {failed && <div className="pdf-original__error">{t('reader.originalLayout.error')}</div>}
      {!numPages && !failed && !sessionExpired && <div className="pdf-original__loading">{t('reader.originalLayout.loading')}</div>}

      {/* The engine owns this element's children (pages, canvases, text layers, marks). */}
      <div ref={rootRef} className="pdf-engine__pages" />

      {activeEditHl && editHl && (
        <PdfHighlightPopup
          highlight={activeEditHl}
          rect={editHl.rect}
          containerRef={wrapRef}
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
