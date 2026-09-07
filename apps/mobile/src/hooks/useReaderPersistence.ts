import { useCallback, useEffect, useRef, MutableRefObject, useState } from 'react'
import {
  canPersistPosition,
  restoreGateReduce,
  restoredChapter,
  RESTORE_GATE_INITIAL,
  RESTORE_SETTLE_MS,
  type RestoreGateEvent,
} from '../lib/readerWriteGate'
import { FEATURES, readReaderTextPositionActive } from '../lib/features'
import { useFlushOnBackground } from './useFlushOnBackground'
import type { TextPosition } from '@textstack/shared'
import type { ProgressSnapshot, SavedPosition } from '../components/reader/readerSource'

type Options = {
  /** editionId (catalog) or userBookId (user-book). null disables I/O.
   *  Also the trigger that re-loads the saved position once it resolves. */
  bookKey: string | null
  /** URL chapter slug. Changing it = new chapter → reset + re-restore. */
  chapterSlug: string | undefined
  /** Loaded chapter id — null until the chapter fetch lands. */
  chapterId: string | null
  injectJs: (js: string) => void

  // Live scroll refs (mutated by ReaderShell on the WebView 'progress' msg).
  progressRef: MutableRefObject<number>
  scrollOffsetRef: MutableRefObject<number>
  currentChapterSlugRef: MutableRefObject<string | null>
  bookProgressRef: MutableRefObject<number | null>
  positionRef: MutableRefObject<TextPosition | null>

  /** Source-specific write. MUST be stable (wrap in useCallback). */
  persist: (snap: ProgressSnapshot) => void
  /** Source-specific read of the saved resume position for a chapter.
   *  MUST be stable (wrap in useCallback). */
  loadPosition: (chapterSlug: string) => Promise<SavedPosition>
  /**
   * Route to another chapter. Used only when a document rebuild has landed the
   * reader in a chapter that is not the one they were reading — the route has
   * to follow them, because the position they had is not in this document.
   * MUST be stable (wrap in useCallback).
   */
  navigateToChapter?: (chapterSlug: string) => void
  /**
   * False while a NON-REFLOW viewer owns the reading position — an uploaded PDF
   * opened in Original layout.
   *
   * The refs below are fed by the reflow WebView's `progress` message. A PDF
   * viewer never sends one, so in Original layout they sit at their mount
   * values for the whole session, and anything built from them is fiction:
   * "top of the chapter named in the URL". The unmount flush wrote exactly that
   * — `scroll:<url-slug>:0` — over a perfectly good `page:16`, and QA watched a
   * PDF fall from 14% to 4% and reopen twelve pages early.
   *
   * Guarded at call time rather than by skipping the effect registration:
   * `hasOriginalPdf` is false until the book fetch lands, so a decision made at
   * mount is a decision made on the wrong answer.
   */
  enabled?: boolean
}

/**
 * The ONE place reading-progress is saved and restored, shared by both the
 * catalog and the user-book reader. Replaces the two divergent progress hooks
 * (`useReaderProgress` / `useUserBookProgress`) plus the two copy-pasted
 * restore effects that lived inline in the route files.
 *
 * Save cadence (matches web `useReadingProgress`):
 *   - `bumpProgress()` — 2s-debounced save during scrolling.
 *   - `saveProgress()` — synchronous flush on unmount / AppState background.
 *
 * Restore (the bug this consolidation kills):
 *   The saved position is fetched ASYNCHRONOUSLY, but inline HTML loads fast,
 *   so `onLoadEnd` often fired BEFORE the position arrived — and since restore
 *   ran once, guarded, it was skipped forever → "always returns to top of
 *   chapter". We now gate restore on BOTH signals via a tiny state machine:
 *   restore fires only when `webViewLoaded && positionLoaded`, whichever lands
 *   last. No race, both readers, offset OR percent.
 */
export function useReaderPersistence({
  bookKey,
  chapterSlug,
  chapterId,
  injectJs,
  progressRef,
  scrollOffsetRef,
  currentChapterSlugRef,
  bookProgressRef,
  positionRef,
  persist,
  loadPosition,
  navigateToChapter,
  enabled = true,
}: Options) {
  // Restore state machine — all refs so changes never trigger a re-render.
  const savedOffsetRef = useRef<number | null>(null)
  const savedPercentRef = useRef<number | null>(null)
  const savedPositionRef = useRef<TextPosition | null>(null)
  const restoredRef = useRef(false)
  // State, deliberately, not a ref: a writer has to be able to re-run once restore finishes, and
  // flipping a ref triggers no render. The web reader keeps exactly this, for exactly this reason.
  //
  // What it holds is no longer "a restore was injected" but "the WebView says it got there" — see
  // readerWriteGate. The reducer returns its own state object untouched when nothing transitions,
  // so dispatching on every scroll message costs no render.
  const [gate, setGate] = useState(RESTORE_GATE_INITIAL)
  const restoredFor = restoredChapter(gate)
  const dispatchGate = useCallback((event: RestoreGateEvent) => {
    setGate(prev => restoreGateReduce(prev, event))
  }, [])
  // Mints the token that travels into the WebView and back, so an acknowledgement from the chapter
  // just left cannot open the gate on this one. Mirrors `pdfJumpIdRef` in ReaderShell.
  const restoreIdRef = useRef(0)
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const webViewLoadedRef = useRef(false)
  const positionLoadedRef = useRef(false)
  /** The chapter the reader was in when a rebuild started — see onDocumentRebuild. */
  const rebuiltFromSlugRef = useRef<string | null>(null)
  // Read once per mount. A ref rather than state: it is consulted inside the
  // restore, and a re-render on resolve would re-arm the effect that starts one.
  const textPositionEnabledRef = useRef(FEATURES.readerTextPosition)
  useEffect(() => {
    let cancelled = false
    readReaderTextPositionActive().then(v => { if (!cancelled) textPositionEnabledRef.current = v })
    return () => { cancelled = true }
  }, [])

  /**
   * Mint a restore id, shut the write gate behind it and arm the settle timeout.
   *
   * Every move the reader did not make goes through here: the saved-position
   * restore below, and a typography reflow, which scrolls the document to keep
   * the reader in place and is indistinguishable from a real scroll on the way
   * back. Whatever the WebView reports between this call and its acknowledgement
   * is a transient, and `canPersistPosition` refuses it.
   */
  const issueRestore = useCallback(() => {
    const restoreId = ++restoreIdRef.current
    dispatchGate({ type: 'restoreIssued', restoreId, at: Date.now() })
    if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null
      dispatchGate({ type: 'restoreTimedOut', restoreId })
    }, RESTORE_SETTLE_MS)
    return restoreId
  }, [dispatchGate])

  const tryRestore = useCallback(() => {
    if (restoredRef.current) return
    if (!webViewLoadedRef.current || !positionLoadedRef.current) return
    // Both signals in — fire exactly once for this chapter mount.
    restoredRef.current = true
    const offset = savedOffsetRef.current
    const pct = savedPercentRef.current
    const pos = savedPositionRef.current
    if (pos == null && offset == null && pct == null) {
      // Nothing saved: the top of the chapter IS the restored position. Open the gate now, or a
      // book opened for the first time could never be saved at all.
      dispatchGate({ type: 'nothingToRestore' })
      return
    }
    // Asked, not arrived. The gate stays shut until the WebView reports back — this is the window
    // in which a back-press used to persist the load event's zero over a half-read book.
    const restoreId = issueRestore()
    // The anchor first: it is the only one of the three that is still true after
    // the text has reflowed. The WebView resolves it against the text it is
    // actually showing and answers with the same ack either way.
    if (pos != null) {
      injectJs(`window.__textstackRestoreAnchor && window.__textstackRestoreAnchor(${JSON.stringify(JSON.stringify(pos))}, ${restoreId})`)
    } else if (offset != null) {
      injectJs(`window.__textstackRestoreScroll && window.__textstackRestoreScroll(${offset}, ${restoreId})`)
    } else {
      injectJs(`window.__textstackRestorePercent && window.__textstackRestorePercent(${pct}, ${restoreId})`)
    }
  }, [injectJs, dispatchGate, issueRestore])

  /** The WebView finished a restore we asked for. Signalled by ReaderShell's `restored` message. */
  const onRestoreLanded = useCallback((restoreId: number) => {
    dispatchGate({ type: 'restoreLanded', restoreId })
  }, [dispatchGate])

  /**
   * A rebuild of the WebView document is starting.
   *
   * Called by ReaderShell the moment its document key changes — which is before
   * the new document loads, and that ordering is the whole point. A rebuilt
   * document is built from the ROUTE chapter, and the reader may be in a later
   * one that infinite scroll appended; the only moment that fact is still
   * knowable is now, because the fresh document's load event overwrites
   * `currentChapterSlugRef` with the route chapter.
   *
   * The gate is shut here too. Between a rebuild and its restore the newest
   * position we hold is the load event's zero, which is exactly the value that
   * used to be written over a half-read book.
   */
  const onDocumentRebuild = useCallback(() => {
    rebuiltFromSlugRef.current = currentChapterSlugRef.current
    dispatchGate({ type: 'chapterEntered', chapterSlug: chapterSlug ?? null })
  }, [dispatchGate, chapterSlug, currentChapterSlugRef])

  // Signalled by ReaderShell's onLoadEnd.
  const onWebViewLoaded = useCallback(() => {
    // Already restored this chapter once → this onLoadEnd is a rebuild.
    //
    // This branch used to re-apply `progressRef` — the reader's fraction of
    // whatever chapter they were IN — as a percent of the freshly built
    // document, which contains the chapter the ROUTE names. Reading 55% of
    // chapter two put the reader at 74% of chapter one, and the debounced save
    // wrote it. Typography no longer rebuilds at all (see readerChrome.ts), but
    // a re-parsed chapter, an overlay-flag flip or the OpenDyslexic face still
    // do, so the branch has to be right rather than absent.
    if (restoredRef.current) {
      const wasIn = rebuiltFromSlugRef.current
      rebuiltFromSlugRef.current = null
      if (wasIn && chapterSlug && wasIn !== chapterSlug) {
        // The reader is not in the chapter this document was built from. There
        // is nothing here to restore them to — go and get the chapter they are
        // actually in, and its own restore runs on arrival. The gate stays shut
        // until then, which is why nothing can be written in between.
        navigateToChapter?.(wasIn)
        return
      }
      const pct = progressRef.current
      const restoreId = issueRestore()
      if (Number.isFinite(pct) && pct > 0.001) {
        injectJs(`window.__textstackRestorePercent && window.__textstackRestorePercent(${pct}, ${restoreId})`)
      } else {
        // Top of the chapter is where they were; nothing to ask the WebView for.
        dispatchGate({ type: 'restoreLanded', restoreId })
      }
      return
    }
    webViewLoadedRef.current = true
    tryRestore()
  }, [tryRestore, injectJs, progressRef, chapterSlug, navigateToChapter, issueRestore, dispatchGate])

  // Pending-save buffer: chapterId resolves AFTER the chapter fetch lands, so a
  // save requested during rapid chapter tap-through (e.g. emit-on-load firing
  // before the destination chapter's id is known) would early-return and the
  // destination chapter's first progress would be lost. Instead we stash a flag
  // and replay the save once chapterId resolves (effect below). We don't snapshot
  // the payload values — saveProgress already reads the live refs at flush time,
  // which carry the latest scroll/percent for the destination chapter.
  const pendingSaveRef = useRef(false)

  const saveProgress = useCallback(() => {
    // `enabled` first: when another viewer owns the position, the refs this
    // function reads have never been written, and writing them destroys a real
    // position. One check covers all three callers — the unmount flush, the
    // exit-summary save and the AppState background flush — because
    // `saveProgressRef` is refreshed every render.
    // Also refuses until this chapter's restore has completed. Without it the WebView's
    // own load-event progress message — scrollY 0, no user action — reached the server and
    // overwrote a reader's real position with zero. See readerWriteGate.
    const gate = { enabled, bookKey, chapterSlug, restoredFor }
    if (!canPersistPosition(gate)) return
    // NOTE: a missing chapterId does NOT block the save. The offline cache
    // stores chapters by slug and has no server id to give (`id: ''` in
    // useReaderChapter), so gating on it meant every save while offline was
    // deferred — and the replay effect below, gated the same way, never fired.
    // Read three chapters on a plane, close the app, lose all of it. The slug
    // is what the local record is keyed by; each source decides for itself
    // whether it has enough to also write to the server.
    const slug = currentChapterSlugRef.current || gate.chapterSlug
    persist({
      chapterId,
      chapterSlug: slug,
      chapterPercent: progressRef.current,
      scrollOffset: scrollOffsetRef.current,
      // Only when it belongs to the chapter being saved. The refs are written by
      // one message each, and a progress message with no text under the reading
      // line leaves the position at its previous value — which may name the
      // chapter before this one.
      position: positionRef.current?.chapterSlug === slug ? positionRef.current : null,
      bookPercent: bookProgressRef.current,
      updatedAt: Date.now(),
    })
    // Saved locally, but the server write needs a real chapter id. Remember to
    // repeat the save if one arrives (chapter fetch lands, or the device comes
    // back online and the next chapter resolves normally).
    pendingSaveRef.current = !chapterId
  }, [enabled, bookKey, chapterId, chapterSlug, restoredFor, persist, currentChapterSlugRef, progressRef, scrollOffsetRef, bookProgressRef, positionRef])

  // Re-save once the chapter id lands, so the server gets the write that the
  // local store already has. Harmless when the id was there from the start.
  useEffect(() => {
    if (chapterId && pendingSaveRef.current) {
      pendingSaveRef.current = false
      saveProgress()
    }
  }, [chapterId, saveProgress])

  // 2s-debounced save fired on every WebView progress bump. Short enough that
  // a force-kill mid-chapter loses < ~2s of scroll, long enough that fast
  // scrubbing doesn't spam writes.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bumpProgress = useCallback(() => {
    // ReaderShell has just written the live refs from the WebView's message, so this is also where
    // the gate learns the reader is somewhere real — the standby for an acknowledgement that never
    // arrived. A zero, which is what the load event sends, opens nothing.
    dispatchGate({ type: 'positionReported', scrollY: scrollOffsetRef.current })
    // Nothing to debounce toward — don't arm a timer that will no-op. The restore gate is checked
    // here as well as inside saveProgress, so the load-event bump does not leave a timer running
    // into the window where the gate has just opened.
    if (!canPersistPosition({ enabled, bookKey, chapterSlug, restoredFor })) return
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null
      saveProgress()
    }, 2000)
  }, [enabled, bookKey, chapterSlug, restoredFor, saveProgress, dispatchGate, scrollOffsetRef])

  // Load saved position + reset the restore machine whenever the chapter (or
  // the resolved bookKey) changes. One-shot per (bookKey, chapterSlug).
  useEffect(() => {
    restoredRef.current = false
    // Closes the write gate for the chapter being entered. A single boolean would stay open and
    // let the new chapter be persisted at offset 0 before its own restore had run.
    dispatchGate({ type: 'chapterEntered', chapterSlug: chapterSlug ?? null })
    if (settleTimerRef.current) { clearTimeout(settleTimerRef.current); settleTimerRef.current = null }
    webViewLoadedRef.current = false
    positionLoadedRef.current = false
    savedOffsetRef.current = null
    savedPercentRef.current = null
    savedPositionRef.current = null
    pendingSaveRef.current = false
    // Restoring a reflow scroll position into a PDF viewer would fight the
    // page jump the PDF path is already performing.
    if (!enabled || !bookKey || !chapterSlug) return
    let cancelled = false
    loadPosition(chapterSlug)
      .then(pos => {
        if (cancelled) return
        savedOffsetRef.current = pos.offset
        savedPercentRef.current = pos.percent
        // Gated read (features.ts): flipping the flag off falls back to the pixel
        // offset written beside it, which is exactly the old behaviour. The WRITE
        // is never gated, so a device switched off keeps accumulating positions.
        savedPositionRef.current = textPositionEnabledRef.current ? pos.position : null
        positionLoadedRef.current = true
        tryRestore()
      })
      .catch(() => {
        if (cancelled) return
        positionLoadedRef.current = true
        tryRestore()
      })
    return () => { cancelled = true }
    // `enabled` is a dependency so the corrupt-PDF "read as text" fallback
    // (forceReflow) re-arms restore when it flips.
  }, [enabled, bookKey, chapterSlug, loadPosition, tryRestore, dispatchGate])

  // Always points at the current closure, so the unmount flush below can have
  // an empty dependency list without going stale.
  const saveProgressRef = useRef(saveProgress)
  saveProgressRef.current = saveProgress

  // Flush on unmount — covers tab-away and a killed screen in a single tap.
  //
  // Depending on `saveProgress` here made this cleanup fire on every chapter
  // change too, and that was destructive: `navigateChapter` saves the real
  // position, THEN zeroes the live refs, THEN pushes the route. The route
  // change altered `saveProgress`'s identity, so React ran this cleanup with
  // the OLD chapter's closure over the freshly ZEROED refs and persisted
  // `percent: 0, locator: scroll:<old-slug>:0`. Until the destination chapter
  // emitted its first progress message, the only stored position for the book
  // was "the chapter you just left, at the top" — and killing the app in that
  // window, or navigating offline, made that the position you came back to.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      if (settleTimerRef.current) clearTimeout(settleTimerRef.current)
      saveProgressRef.current()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Android OS-kill skips React cleanup; AppState background fires first so we
  // get one last sync write of scroll position + book-percent cache.
  useFlushOnBackground(saveProgress)

  return { saveProgress, bumpProgress, onWebViewLoaded, onRestoreLanded, onDocumentRebuild, beginReflow: issueRestore }
}
