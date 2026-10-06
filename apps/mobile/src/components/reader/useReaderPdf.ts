import { useEffect, useState, useRef, useCallback } from 'react'
import type { MutableRefObject } from 'react'
import { AppState } from 'react-native'
import { t, resolvePdfResumePage, chapterEndPage, isFirstPagedChapter, pdfGateReduce, PDF_GATE_INITIAL, type PdfGateState, type Language } from '@textstack/shared'
import { getAccessToken, onUnauthorized } from '../../lib/api'
import { useToast } from '../../context/ToastContext'
import { returnedToForeground, decideNewerPosition, readerMovedSince } from '../../lib/progressRestore'
import { initialPdfJump } from '../../lib/pdfInitialJump'
import type { ReaderShellProps } from './readerShellTypes'

type Args = Pick<ReaderShellProps,
  | 'original' | 'originalFileUrl' | 'originalInitialPage' | 'originalChapterPicked' | 'originalResumePage' | 'originalResumeReady'
  | 'originalNewerPage' | 'persistPdfPage' | 'chapters' | 'chapterSlug' | 'injectJs'
> & {
  language: Language
  /** False once the reader unmounted — a failed recovery then shows no toast. */
  aliveRef: MutableRefObject<boolean>
  recordSessionActivity: () => void
  /** Re-push the highlight set into the viewer. */
  repaintPdf: () => void
}

/**
 * ADR-012 S4b/S4c — the Original-layout PDF viewer's wiring inside the reader shell: the Bearer
 * token, the initial page resolution and its persist gate, the newer-page offer, the silent 401
 * recovery and the viewer's `pdf*` messages. Inert when `original` is false.
 */
export function useReaderPdf({
  original, originalFileUrl, originalInitialPage, originalChapterPicked, originalResumePage, originalResumeReady,
  originalNewerPage, persistPdfPage, chapters, chapterSlug, injectJs,
  language, aliveRef, recordSessionActivity, repaintPdf,
}: Args) {
  const { show: showToast, dismiss: hideToast } = useToast()
  // The PDF newer-page prompt, hidden when the reader closes (M1).
  const pdfNewerToastRef = useRef<number | null>(null)
  useEffect(() => () => hideToast(pdfNewerToastRef.current), [hideToast])

  // --- ADR-012 S4b: Original-layout PDF viewer state ------------------------
  // The Bearer token is fetched once and injected into pdf.js httpHeaders via
  // the viewer HTML. On a mid-read Range 401 the WebView posts `pdfAuthExpired`
  // → we refresh (shared single-flight) and rebuild the source (nonce bump)
  // restoring the current page — no visible banner (mobile UX).
  const [pdfToken, setPdfToken] = useState<string | null>(null)
  const [pdfTokenReady, setPdfTokenReady] = useState(false)
  const [pdfReloadNonce, setPdfReloadNonce] = useState(0)
  const currentPdfPageRef = useRef<number | null>(null)
  const pdfInitialPageRef = useRef<number | null>(originalInitialPage ?? null)
  // S4c — top-visible page + page count for the PDF chrome + page-bookmark
  // state. Kept in React state (not just the ref) so the chrome + bookmark icon
  // re-render as the user scrolls.
  const [pdfCurrentPage, setPdfCurrentPage] = useState(originalInitialPage ?? 1)
  const [pdfNumPages, setPdfNumPages] = useState(0)
  // Same count, readable synchronously by the first jump (it runs inside the pdfReady handler).
  const pdfNumPagesRef = useRef<number | null>(null)
  // S4c — corrupt / unreadable PDF surfaced by the viewer (pdfLoadError).
  const [pdfError, setPdfError] = useState(false)
  const pdfReadyRef = useRef(false)
  // Replaces `pdfInitialJumpDoneRef`, a boolean that was set before the jump was
  // even computed and never reset — see pdfPersistGate.ts.
  const pdfGateRef = useRef<PdfGateState>(PDF_GATE_INITIAL)
  const pdfJumpIdRef = useRef(0)
  // Page the initial resolution sent the viewer to — "has the reader moved since?".
  const pdfResumedPageRef = useRef<number | null>(null)
  // True while the document being opened is a RELOAD of one already in progress
  // (the silent 401 recovery). The bootstrap carries the tracked page, so the
  // resume logic must not run again and pull the reader back to the chapter start.
  const pdfIsReloadRef = useRef(false)

  /** A downloaded original is read off the disk: no Bearer, no Range stream, no
   *  silent-401 recovery. Everything below (and useReaderDocument) branches on this one fact. */
  const isLocalOriginal = !!originalFileUrl && originalFileUrl.startsWith('file://')

  useEffect(() => {
    if (!original) return
    if (isLocalOriginal) {
      // Nothing to wait for. Without this the viewer would sit on the blank
      // placeholder until a token arrived for a request it never makes —
      // offline, that means until the refresh times out.
      setPdfToken(null)
      setPdfTokenReady(true)
      return
    }
    let cancelled = false
    getAccessToken().then(tok => {
      if (cancelled) return
      setPdfToken(tok)
      setPdfTokenReady(true)
    })
    return () => { cancelled = true }
  }, [original, isLocalOriginal])

  // Inbound bridge to the pdf.js viewer — TOC jumps, page-input jumps, and the
  // server-resume initial jump all route through `window.scrollToPage(n)`.
  //
  // It is also the ONLY place a jump is issued, which is what lets the persist
  // gate know that pages reported between here and the landing are the viewer
  // travelling, not the reader reading. Every caller — resume, table of contents,
  // page input, bookmarks, highlights — goes through it, so none of them can
  // forget to arm the gate.
  const scrollPdfToPage = useCallback((page: number) => {
    const target = Math.max(1, Math.floor(page))
    const jumpId = ++pdfJumpIdRef.current
    pdfGateRef.current = pdfGateReduce(pdfGateRef.current, {
      type: 'jumpIssued', page: target, jumpId, at: Date.now(),
    }).state
    injectJs(`window.scrollToPage && window.scrollToPage(${target}, ${jumpId})`)
  }, [injectJs])

  // Initial page resolution for the Original PDF.
  //
  // The chapter start page is applied by the viewer bootstrap (`initialPage`),
  // so this handles the SERVER resume page — once the doc is ready AND the
  // resume fetch has resolved.
  //
  // "Chapter always wins" used to be the rule, and it made resuming a PDF
  // impossible: the detail screen had no chapter slug to route by (a PDF's
  // position is a page locator), so it always opened chapter one, whose start
  // page is 1, which then discarded the saved page. The rule is now narrower —
  // a saved page INSIDE the chapter being opened wins. That separates the two
  // ways a reader arrives without needing a flag: picking chapter 7 from the
  // table of contents opens chapter 7, while Continue routes to the chapter
  // holding the saved page and lands on the page itself.
  const maybeInitialPdfJump = useCallback(() => {
    if (!original || !pdfReadyRef.current || pdfGateRef.current.phase !== 'awaitingTarget') return
    if (pdfIsReloadRef.current) {
      // A reload already opens at the tracked page via the bootstrap. Re-running
      // the resume resolution here would send the reader back to the chapter
      // start, which is the opposite of recovering their position.
      pdfIsReloadRef.current = false
      pdfGateRef.current = pdfGateReduce(pdfGateRef.current, { type: 'noJumpNeeded' }).state
      return
    }
    // Waits for the device's page even when the chapter's start page is known (R4 bug 2) — a local
    // read, never the network. A saved page inside this chapter wins over its start.
    const idx = chapters.findIndex(c => c.slug === chapterSlug)
    const first = initialPdfJump({
      resumeReady: !!originalResumeReady,
      chapterStartPage: originalInitialPage,
      chapterEndPage: idx >= 0 ? chapterEndPage(chapters, idx) : null,
      // Only Continue lets chapter one claim a saved front-matter page; a pick opens its start.
      firstChapter: !originalChapterPicked && isFirstPagedChapter(chapters, idx),
      // A newer server page that arrived before the jump is simply the target ('adopt').
      resumePage: originalNewerPage?.page ?? originalResumePage,
      pageCount: pdfNumPagesRef.current,
    })
    if (first.kind === 'wait') return
    pdfResumedPageRef.current = first.page
    // The gate is armed by `scrollPdfToPage` itself, AFTER the target is known —
    // the old code set its flag first and then computed the target, so the
    // viewer's page-1 report sailed through the guard meant to catch it.
    if (first.kind === 'jump') scrollPdfToPage(first.page)
    else pdfGateRef.current = pdfGateReduce(pdfGateRef.current, { type: 'noJumpNeeded' }).state
  }, [original, originalInitialPage, originalChapterPicked, originalResumeReady, originalResumePage, originalNewerPage, scrollPdfToPage, chapters, chapterSlug])

  // A newer page from the server, after the document already opened at the
  // device's one. Same rule as the reflow reader (decideNewerPosition): not
  // moved since → go there; moved, or outside the chapter opened → ask once.
  const pdfNewerHandledRef = useRef<number | null>(null)
  // The page on screen when the app last came back to the foreground — the "moved since?" baseline
  // for an offer found by the return check (H3), like the reflow reader's.
  const pdfReturnPageRef = useRef<number | null>(null)
  useEffect(() => {
    let prev: string = AppState.currentState
    const sub = AppState.addEventListener('change', next => {
      if (returnedToForeground(prev, next)) pdfReturnPageRef.current = currentPdfPageRef.current
      prev = next
    })
    return () => sub.remove()
  }, [])
  useEffect(() => {
    if (!original || originalNewerPage == null || pdfNewerHandledRef.current === originalNewerPage.at) return
    // Not jumped yet: maybeInitialPdfJump picks it up as the target.
    if (pdfGateRef.current.phase === 'awaitingTarget') return
    pdfNewerHandledRef.current = originalNewerPage.at
    const page = originalNewerPage.page
    const idx = chapters.findIndex(c => c.slug === chapterSlug)
    const inChapter = resolvePdfResumePage({
      chapterStartPage: originalInitialPage,
      chapterEndPage: idx >= 0 ? chapterEndPage(chapters, idx) : null,
      firstChapter: isFirstPagedChapter(chapters, idx),
      resumePage: page,
    }) === page
    const action = decideNewerPosition({
      sameChapter: inChapter,
      restoreApplied: true,
      readerMoved: readerMovedSince(originalNewerPage.onReturn ? pdfReturnPageRef.current : pdfResumedPageRef.current, currentPdfPageRef.current, 0),
    })
    if (action === 'move') { scrollPdfToPage(page); return }
    pdfNewerToastRef.current = showToast({
      variant: 'info',
      icon: 'phone-portrait-outline',
      message: t(language, 'reader.newerElsewhere.message')
        .replace('{target}', t(language, 'reader.newerElsewhere.page').replace('{page}', String(page))),
      actionLabel: t(language, 'reader.newerElsewhere.action'),
      onPress: () => scrollPdfToPage(page),
      duration: 8000,
    })
  }, [original, originalNewerPage, originalInitialPage, chapters, chapterSlug, scrollPdfToPage, showToast, language])

  // L4: the refresh behind a mid-read Range 401 can fail too (offline, captive portal, a session
  // that is gone). That was silent — the pages past the loaded ones just stayed blank. Now the
  // reader is told, with a Retry that runs the same recovery again.
  const pdfAuthToastRef = useRef<number | null>(null)
  useEffect(() => () => hideToast(pdfAuthToastRef.current), [hideToast])
  const recoverPdfAuthRef = useRef<() => void>(() => {})
  recoverPdfAuthRef.current = () => {
    onUnauthorized().then(tok => {
      if (tok) {
        setPdfToken(tok)
        setPdfReloadNonce(n => n + 1)
        return
      }
      if (!aliveRef.current) return
      pdfAuthToastRef.current = showToast({
        variant: 'info',
        icon: 'cloud-offline-outline',
        message: t(language, 'reader.pdfReconnect'),
        actionLabel: t(language, 'common.retry'),
        onPress: () => recoverPdfAuthRef.current(),
        duration: 8000,
      })
    })
  }

  // Run the deferred initial jump once the async server resume page arrives
  // after the viewer was already ready.
  useEffect(() => { maybeInitialPdfJump() }, [maybeInitialPdfJump])

  /** The viewer's `pdf*` messages. True when the message was one of them. */
  const onMessage = useCallback((data: any): boolean => {
    if (data.type === 'pdfReady') {
      // Document opened — record page count, clear any prior error, and run
      // the deferred server-resume initial jump if the fetch already resolved.
      if (typeof data.numPages === 'number') { setPdfNumPages(data.numPages); pdfNumPagesRef.current = data.numPages }
      pdfReadyRef.current = true
      setPdfError(false)
      // Close the persist gate for this document. Without it, a reload (bar
      // toggle, token refresh) left the gate from the PREVIOUS document open,
      // and the fresh document's page-1 report was saved as the position.
      pdfGateRef.current = pdfGateReduce(pdfGateRef.current, { type: 'documentLoaded' }).state
      maybeInitialPdfJump()
      // Viewer is up — (re)push any highlights loaded before it was ready.
      repaintPdf()
    } else if (data.type === 'pdfPage') {
      // Top-visible page (throttled). Track it (auth-expired reload restore +
      // chrome + page-bookmark state), persist page-based progress (debounced,
      // NOT word-based), and keep the reading session alive on time.
      if (typeof data.page === 'number') {
        currentPdfPageRef.current = data.page
        setPdfCurrentPage(data.page)
        recordSessionActivity()
        if (typeof data.numPages === 'number') {
          setPdfNumPages(data.numPages)
          // Provenance, not ordering: only pages the reader chose to be on are
          // saved. See pdfPersistGate.ts for why a monotonic guard would be the
          // wrong shape here.
          const decision = pdfGateReduce(pdfGateRef.current, {
            type: 'pageReported', page: data.page, ackJumpId: data.jumpId, at: Date.now(),
          })
          pdfGateRef.current = decision.state
          if (decision.persist) persistPdfPage?.(data.page, data.numPages)
        }
      }
    } else if (data.type === 'pdfAuthExpired') {
      // Silent recovery: remember the page, refresh the token (shared
      // single-flight), then rebuild the viewer source with the fresh token.
      pdfInitialPageRef.current = currentPdfPageRef.current ?? pdfInitialPageRef.current
      pdfIsReloadRef.current = true
      recoverPdfAuthRef.current()
    } else if (data.type === 'pdfLoadError') {
      // Corrupt / unreadable PDF (NOT the 401 reload path). Surface the reader
      // error state → "open as text" (if reflow chapters exist) or hard error.
      if (__DEV__) console.warn('[reader] pdf load error:', data.message)
      setPdfError(true)
    } else return false
    return true
  }, [maybeInitialPdfJump, persistPdfPage, recordSessionActivity, repaintPdf])

  return {
    pdfToken, pdfTokenReady, pdfReloadNonce, isLocalOriginal,
    currentPdfPageRef, pdfInitialPageRef, pdfReadyRef, pdfIsReloadRef,
    pdfCurrentPage, pdfNumPages, pdfError, setPdfError,
    scrollPdfToPage, onMessage,
  }
}
