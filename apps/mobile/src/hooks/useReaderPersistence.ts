import { useCallback, useEffect, useRef, MutableRefObject, useState } from 'react'
import {
  canPersistPosition,
  restoreGateReduce,
  restoredChapter,
  RESTORE_GATE_INITIAL,
  RESTORE_SETTLE_MS,
  type RestoreGateEvent,
} from '../lib/readerWriteGate'
import { useFlushOnBackground } from './useFlushOnBackground'
import { t, type TextPosition } from '@textstack/shared'
import type { NewerPosition, ProgressSnapshot, SavedPosition } from '../components/reader/readerSource'
import { decideNewerPosition, readerMovedSince, REFLOW_MOVE_TOLERANCE_PX } from '../lib/progressRestore'
import { useToast } from '../context/ToastContext'
import { useLanguage } from '../context/LanguageContext'

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

  /** Source-specific write. MUST be stable (wrap in useCallback). Returns the
   *  server write when one was made, so a caller can wait for it (Discuss). */
  persist: (snap: ProgressSnapshot) => Promise<unknown> | void
  /** Source-specific read of the saved resume position for a chapter — from the
   *  DEVICE only. The open never waits on a network (progressRestoreOrder.test.ts).
   *  MUST be stable (wrap in useCallback). */
  loadPosition: (chapterSlug: string) => Promise<SavedPosition>
  /** Background, started after `loadPosition` and never awaited by the open: a
   *  position the server holds that is provably newer than the local record the
   *  chapter opened from, or null. MUST be stable. */
  loadNewerPosition?: (chapterSlug: string) => Promise<NewerPosition | null>
  /** Opens another chapter — the prompt's action when the newer position is there. */
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
  loadNewerPosition,
  navigateToChapter,
  enabled = true,
}: Options) {
  const { show: showToast } = useToast()
  const { language } = useLanguage()
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

  /** Scroll the WebView to the saved refs (anchor → offset → percent), behind a fresh restore id. */
  const injectSaved = useCallback(() => {
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

  const tryRestore = useCallback(() => {
    if (restoredRef.current) return
    if (!webViewLoadedRef.current || !positionLoadedRef.current) return
    // Both signals in — fire exactly once for this chapter mount.
    restoredRef.current = true
    injectSaved()
  }, [injectSaved])

  // First scroll offset reported after this chapter's restore settled — the
  // "has the reader moved since?" baseline. Null: nothing reported yet.
  const moveBaselineRef = useRef<number | null>(null)
  const chapterSlugRef = useRef(chapterSlug)
  chapterSlugRef.current = chapterSlug

  /**
   * The server answered, after the open, with a newer position. Adopt it as the
   * restore target, move there, or ask — never yank a reader who has moved.
   */
  const applyNewer = useCallback((newer: NewerPosition, openedSlug: string) => {
    const goHere = () => {
      savedOffsetRef.current = newer.saved.offset
      savedPercentRef.current = newer.saved.percent
      savedPositionRef.current = newer.saved.position
      moveBaselineRef.current = null
      injectSaved()
    }
    const action = decideNewerPosition({
      sameChapter: newer.chapterSlug === openedSlug,
      restoreApplied: restoredRef.current,
      readerMoved: readerMovedSince(moveBaselineRef.current, scrollOffsetRef.current, REFLOW_MOVE_TOLERANCE_PX),
    })
    if (action === 'adopt') {
      // Not injected yet: tryRestore will use these when the WebView is ready.
      savedOffsetRef.current = newer.saved.offset
      savedPercentRef.current = newer.saved.percent
      savedPositionRef.current = newer.saved.position
      return
    }
    if (action === 'move') { goHere(); return }
    showToast({
      variant: 'info',
      icon: 'phone-portrait-outline',
      message: t(language, 'reader.newerElsewhere.message').replace('{target}', newer.label),
      actionLabel: t(language, 'reader.newerElsewhere.action'),
      // Still in the chapter it was found for → scroll; otherwise open that chapter,
      // whose own background check then lands on the position.
      onPress: () => {
        if (chapterSlugRef.current === newer.chapterSlug) goHere()
        else navigateToChapter?.(newer.chapterSlug)
      },
      duration: 8000,
    })
  }, [injectSaved, scrollOffsetRef, showToast, language, navigateToChapter])
  // Read through refs by the load effect, so a new identity (language, auth,
  // chapter list) never re-runs it — that would reset a restore already done.
  const applyNewerRef = useRef(applyNewer)
  applyNewerRef.current = applyNewer
  const loadNewerRef = useRef(loadNewerPosition)
  loadNewerRef.current = loadNewerPosition

  /** The WebView finished a restore we asked for. Signalled by ReaderShell's `restored` message. */
  const onRestoreLanded = useCallback((restoreId: number) => {
    dispatchGate({ type: 'restoreLanded', restoreId })
  }, [dispatchGate])

  /**
   * A rebuild of the WebView document is starting (a re-parsed chapter, the
   * OpenDyslexic face) — told by ReaderShell before the new document loads.
   * Between a rebuild and its restore the newest position we hold is the load
   * event's zero, which is exactly the value that used to be written over a
   * half-read book, so the gate shuts here.
   */
  const onDocumentRebuild = useCallback(() => {
    dispatchGate({ type: 'chapterEntered', chapterSlug: chapterSlug ?? null })
  }, [dispatchGate, chapterSlug])

  // Signalled by ReaderShell's onLoadEnd.
  const onWebViewLoaded = useCallback(() => {
    // Already restored this chapter once → this onLoadEnd is a rebuild of the
    // same chapter (the document holds one chapter, so the fraction applies).
    if (restoredRef.current) {
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
  }, [tryRestore, injectJs, progressRef, issueRestore, dispatchGate])

  // Pending-save buffer: chapterId resolves AFTER the chapter fetch lands, so a
  // save requested during rapid chapter tap-through (e.g. emit-on-load firing
  // before the destination chapter's id is known) would early-return and the
  // destination chapter's first progress would be lost. Instead we stash a flag
  // and replay the save once chapterId resolves (effect below). We don't snapshot
  // the payload values — saveProgress already reads the live refs at flush time,
  // which carry the latest scroll/percent for the destination chapter.
  const pendingSaveRef = useRef(false)

  const saveProgress = useCallback((): Promise<unknown> | void => {
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
    const written = persist({
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
    return written
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
    if (restoredFor === chapterSlug && moveBaselineRef.current == null) moveBaselineRef.current = scrollOffsetRef.current
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
    moveBaselineRef.current = null
    pendingSaveRef.current = false
    // Restoring a reflow scroll position into a PDF viewer would fight the
    // page jump the PDF path is already performing.
    if (!enabled || !bookKey || !chapterSlug) return
    let cancelled = false
    const openedSlug = chapterSlug
    // The open path: the device's record, then the restore. Nothing here waits
    // on a network — the server is asked only after, in the background, and can
    // only add a newer position (applyNewer).
    const checkServer = () => {
      const load = loadNewerRef.current
      if (!load) return
      load(openedSlug)
        .then(newer => { if (!cancelled && newer) applyNewerRef.current(newer, openedSlug) })
        .catch(() => { /* offline / no row: the local restore stands */ })
    }
    loadPosition(chapterSlug)
      .then(pos => {
        if (cancelled) return
        savedOffsetRef.current = pos.offset
        savedPercentRef.current = pos.percent
        savedPositionRef.current = pos.position
        positionLoadedRef.current = true
        tryRestore()
        checkServer()
      })
      .catch(() => {
        if (cancelled) return
        positionLoadedRef.current = true
        tryRestore()
        checkServer()
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
