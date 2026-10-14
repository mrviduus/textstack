import { useCallback, useEffect, useRef, useState } from 'react'
import { parseScrollLocator, decideNewerPosition, readerMovedSince, REFLOW_MOVE_TOLERANCE_PX } from '@textstack/shared'
import { locatorToPosition, positionToLocator, type Locator } from '@textstack/reader-engine'
import { mountedEngineFor } from '../lib/readerEngine'
import type { NewerPositionResult } from './useReaderProgress'
import { useNewerPositionCheck } from './useNewerPositionCheck'
import type { BookDetail } from '../types/api'
import type { ReaderMode } from './useReaderChapter'

interface ProgressLocator {
  locator?: string | null
  /** Serialised TextPosition (ADR-015). Preferred over `locator` when present. */
  positionJson?: string | null
}

interface PublicProgressApi {
  updateProgress: (
    percent: number,
    page?: number,
    scrollLocator?: string,
    overrideChapterId?: string,
    overrideChapterSlug?: string,
    positionJson?: string,
  ) => void
  flushSave: () => void
}

interface UserProgressApi {
  saveProgress: (chapterSlug: string, page: number, percent: number, locator?: string, positionJson?: string) => Promise<void> | void
  flushSave: () => void
}

interface Params {
  mode: ReaderMode
  chapterIdentifier: string | undefined
  chapterLoaded: boolean
  /**
   * True while the Original-layout PDF viewer owns the reading position.
   *
   * This hook writes `scroll:<identifier>:<offset>`. A PDF read in Original
   * layout stores `page:<n>`, and the two are different coordinate spaces —
   * writing one over the other loses the reader's place. The mobile app had the
   * same gap and lost a reader twelve pages; here it is worse hidden, because an
   * uploaded PDF usually HAS reflow chapters, so `chapterLoaded` is true and the
   * save-on-open fires while the reader is looking at pages.
   *
   * See ADR-013.
   */
  originalActive: boolean
  overallProgress: number
  effectiveProgress: ProgressLocator | null
  effectiveLoading: boolean
  publicBookChapters: BookDetail['chapters'] | undefined
  publicProgress: PublicProgressApi
  userProgress: UserProgressApi
  /**
   * A `?highlight=` link is positioning the reader. Restore and save-on-open
   * wait: the link either lands (markPositioned) or gives up, and only then
   * does the normal restore run.
   */
  holdRestore?: boolean
  /** The hold hit its deadline (HOLD_DEADLINE_MS after the chapter is ready) and was dropped. */
  onHoldExpired?: () => void
  /**
   * The restore used this device's record because the server gave no answer (timeout or
   * failure). The server is re-asked in the background (useNewerPositionCheck), and no
   * save-on-open happens: it would stamp the stale local place as the newest write and bury
   * another device's.
   */
  serverUnanswered?: boolean
  /** Re-ask the server for a provably newer position (useReaderProgress). */
  fetchNewerPosition?: (signal: AbortSignal) => Promise<NewerPositionResult>
  /**
   * The reader chose where this chapter opens (`?direct=1`, a TOC open). An explicit place
   * beats a newer one from another device: the newer-position check never moves it.
   */
  explicitOpen?: boolean
  /** Every scroll the READER made — never the echo of a restore or a newer-position move. */
  onReaderScroll?: () => void
}

/** The engine's place in this chapter right now, serialised, or null. */
function captureReadingPosition(chapterSlug: string): string | null {
  const here = mountedEngineFor(chapterSlug)?.engine.current()
  return here?.href === chapterSlug ? locatorToPosition(here) : null
}

/**
 * Where the engine goes for a saved place (Phase 4): the text position, with the old pixel offset as
 * the resolution ladder's fallback. Null when neither belongs to this chapter.
 */
function engineTarget(chapterSlug: string, positionJson: string | null | undefined, offset: number): Locator | null {
  const parsed = positionJson ? positionToLocator(positionJson) : null
  const legacy = offset > 0 ? { legacyScrollY: offset } : {}
  if (parsed?.href === chapterSlug) return { ...parsed, locations: { ...parsed.locations, ...legacy } }
  return offset > 0 ? { href: chapterSlug, type: 'text/html', locations: legacy } : null
}

/**
 * Trailing debounce for the scroll save. The last position the reader stopped
 * at is the one that counts; hide / pagehide / unmount / chapter change flush
 * it at once. The progress hooks add their own 2s server debounce on top.
 */
const SAVE_DEBOUNCE_MS = 1500

/** A ?highlight= link may hold restore this long after the chapter is ready, no longer. */
const HOLD_DEADLINE_MS = 5000

/**
 * True only when the chapter in state IS the one the URL asks for and its fetch
 * has settled. `!!chapter` was true for the PREVIOUS chapter while the next one
 * loaded, so a restore ran against the old article, clamped to 0, and the
 * save-on-open wrote `scroll:<new>:0` (C2).
 */
export function isChapterReady(
  chapter: { identifier: string } | null | undefined,
  requested: string | undefined,
  loading: boolean,
): boolean {
  return !loading && !!chapter && !!requested && chapter.identifier === requested
}

function currentScrollTop(): number {
  return (document.scrollingElement || document.documentElement).scrollTop
}

export function useReaderScrollSync({
  mode,
  chapterIdentifier,
  chapterLoaded,
  originalActive,
  overallProgress,
  effectiveProgress,
  effectiveLoading,
  publicBookChapters,
  publicProgress,
  userProgress,
  holdRestore = false,
  onHoldExpired,
  serverUnanswered = false,
  fetchNewerPosition,
  explicitOpen = false,
  onReaderScroll,
}: Params) {
  const scrollRestoredRef = useRef(false)
  const saveTimerRef = useRef<number | null>(null)
  const pendingSaveRef = useRef<{ identifier: string; offset: number } | null>(null)
  // State-backed mirror of scrollRestoredRef so the save-on-open effect can
  // re-run AFTER restore completes (a ref flip won't trigger a re-render).
  // Keyed by the chapter identifier that was restored.
  const [restoredFor, setRestoredFor] = useState<string | null>(null)
  // Guard: emit exactly one save-on-open per opened chapter.
  const savedOnOpenForRef = useRef<string | null>(null)
  // Where this session last left each chapter. The fetched progress is read
  // once per book, so after Next → Prev it still described the position at
  // OPEN, not the one the reader had just left.
  const sessionPositionsRef = useRef(new Map<string, { offset: number; positionJson?: string }>())
  const identifierRef = useRef(chapterIdentifier)
  identifierRef.current = chapterIdentifier

  // Latest props for the stable callbacks below. The progress objects used to
  // be effect deps; they were new every render, so every render re-ran the
  // flush effect's cleanup and shipped a keepalive PUT (M4).
  const latest = useRef({ mode, originalActive, overallProgress, publicBookChapters, publicProgress, userProgress, chapterLoaded, fetchNewerPosition })
  latest.current = { mode, originalActive, overallProgress, publicBookChapters, publicProgress, userProgress, chapterLoaded, fetchNewerPosition }
  // Mobile's rule (ADR-019). Where our own last scrollTo — restore, newer-position move, reflow
  // re-anchor — or the last save left the page. A scroll event landing exactly here is the echo
  // of our scrollTo: never a save. "The reader moved" = more than REFLOW_MOVE_TOLERANCE_PX away.
  const baselineRef = useRef<number | null>(null)
  // Only the first open of this reader is "the open"; a chapter the reader goes to is theirs.
  const firstOpenRef = useRef(true)
  // THE open restored from this device's record with no server answer: until the reader moves
  // past the tolerance, nothing is saved (small scroll-anchoring shifts included).
  const heldOpenRef = useRef(false)
  // The current position was chosen explicitly (a `?highlight=` link, a `?direct=1` open):
  // never replaced by a newer position from elsewhere, until the reader moves on their own.
  const explicitRef = useRef(false)
  const explicitOpenRef = useRef(explicitOpen)
  explicitOpenRef.current = explicitOpen
  const onReaderScrollRef = useRef(onReaderScroll)
  onReaderScrollRef.current = onReaderScroll
  // The reader moved past the tolerance since the baseline was set. With the engine, a re-anchor
  // (style, reflow) moves the baseline along only when they had not: it must not erase their move.
  const readerMovedRef = useRef(false)
  const setBaseline = useCallback((top: number) => {
    baselineRef.current = top
    readerMovedRef.current = false
  }, [])

  /**
   * The one place a reading position is written.
   *
   * Returns whether anything was written.
   */
  const writeProgress = useCallback((identifier: string, offset: number): boolean => {
    const { mode, overallProgress, publicBookChapters, publicProgress, userProgress, chapterLoaded } = latest.current
    const locator = `scroll:${identifier}:${Math.round(offset)}`
    // Captured at write time from the live DOM, so it describes the same instant
    // the offset does — but only while the article on screen IS this chapter.
    // Null when the reading line has no text under it — a margin, a gap, an
    // image — and the locator then travels alone.
    const positionJson = (chapterLoaded && identifierRef.current === identifier
      ? captureReadingPosition(identifier)
      : null) ?? undefined
    sessionPositionsRef.current.set(identifier, { offset, positionJson })
    if (identifier === identifierRef.current) setBaseline(offset)

    if (mode === 'public') {
      const bookChapter = publicBookChapters?.find(c => c.slug === identifier)
      if (!bookChapter) return false
      publicProgress.updateProgress(overallProgress, undefined, locator, bookChapter.id, identifier, positionJson)
      return true
    }
    userProgress.saveProgress(identifier, 0, overallProgress, locator, positionJson)
    return true
  }, [])

  /** Write the pending position now, if any. */
  const writePending = useCallback((): boolean => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    const pending = pendingSaveRef.current
    pendingSaveRef.current = null
    // A PDF viewer's position is not ours to write.
    if (!pending || latest.current.originalActive) return false
    return writeProgress(pending.identifier, pending.offset)
  }, [writeProgress])

  // Every hold has a deadline: if the link never resolves (a book id that never
  // arrives, a list that never loads) restore and every save would stay blocked.
  const [holdExpiredFor, setHoldExpiredFor] = useState<string | null>(null)
  const held = holdRestore && holdExpiredFor !== chapterIdentifier
  const onHoldExpiredRef = useRef(onHoldExpired)
  onHoldExpiredRef.current = onHoldExpired
  useEffect(() => {
    if (!holdRestore) setHoldExpiredFor(null)
  }, [holdRestore])
  useEffect(() => {
    if (!held || !chapterLoaded || originalActive) return
    const forId = chapterIdentifier ?? null
    const timer = window.setTimeout(() => {
      setHoldExpiredFor(forId)
      onHoldExpiredRef.current?.()
    }, HOLD_DEADLINE_MS)
    return () => clearTimeout(timer)
  }, [held, chapterLoaded, originalActive, chapterIdentifier])

  // Reset restore guard on chapter change, and on a layout switch (the Original PDF
  // scrolls the window: back in reflow, its scrollTop is not the chapter's place).
  useEffect(() => {
    scrollRestoredRef.current = false
    heldOpenRef.current = false
    setRestoredFor(null)
  }, [chapterIdentifier, originalActive])

  // The engine's own moves reset the baseline before the scroll event each one causes, so that
  // event reads as our echo, never the reader's — whatever positioned the chapter (restore, a highlight
  // link, a newer position). ReaderPage marks the chapter loaded only once the engine's open has landed.
  const engine = chapterLoaded && !originalActive ? mountedEngineFor(chapterIdentifier)?.engine : undefined
  useEffect(() => engine?.on('relocated', (e) => {
    if (e.reason === 'scroll') return
    if (e.reason === 'open' || e.reason === 'goTo' || !readerMovedRef.current) setBaseline(currentScrollTop())
  }), [engine, setBaseline])

  // Restore scroll: locator must match current chapter. Otherwise scroll to
  // top — React Router preserves scrollY across route changes, so without
  // this, hitting "Next" at the bottom of ch1 leaves you mid-/end-of ch2.
  useEffect(() => {
    if (scrollRestoredRef.current || effectiveLoading || held) return
    if (originalActive || !chapterLoaded) return

    // This session's own last position in this chapter beats anything fetched
    // at open — it is newer by construction.
    const session = chapterIdentifier ? sessionPositionsRef.current.get(chapterIdentifier) : undefined
    const positionJson = session ? session.positionJson : effectiveProgress?.positionJson

    // The text position first (the engine's goTo ladder): it is the only one of the two that is still
    // true after the text has reflowed — a font size change, a different screen width, a re-parsed
    // book, or simply the phone this was last read on. The pixel offset is what a row written by an
    // older build has to offer, parsed with the SHARED parser rather than the split(':') this used to
    // do inline: a chapter slug containing a colon made that return the wrong slug and an offset of 0.
    const parsed = parseScrollLocator(effectiveProgress?.locator)
    const savedOffset = session
      ? session.offset
      : parsed && parsed.slug === chapterIdentifier ? parsed.offset : 0

    const forId = chapterIdentifier
    const landed = () => {
      // Where the browser actually put us (clamped to the page), not where we asked.
      setBaseline(currentScrollTop())
      explicitRef.current = explicitOpenRef.current
      scrollRestoredRef.current = true
      setRestoredFor(forId ?? null)
    }

    const mounted = mountedEngineFor(forId)
    if (!mounted || !forId) return
    const at = engineTarget(forId, positionJson, savedOffset)
      ?? { href: forId, type: 'text/html', locations: { progression: 0 } }
    // Superseded = a newer restore (this effect re-ran) took over: that one lands.
    void mounted.engine.goTo(at).then((r) => {
      if (r !== 'superseded' && identifierRef.current === forId) landed()
    })
  }, [originalActive, chapterLoaded, effectiveLoading, effectiveProgress, chapterIdentifier, held])

  /** Something else (a `?highlight=` jump) positioned the reader: treat it as the restore. */
  const markPositioned = useCallback(() => {
    const id = identifierRef.current
    if (!id) return
    scrollRestoredRef.current = true
    setRestoredFor(id)
    setBaseline(currentScrollTop())
    explicitRef.current = true
  }, [])

  /**
   * Ask the server whether another device recorded a newer place, and go there if the reader
   * has not moved since the last restore or save. Mobile's rules (decideNewerPosition), minus
   * the prompt: web never asks and never leaves the chapter — the reader's next scroll decides.
   * An explicit position (highlight link, direct open) is never replaced.
   * Resolves true once the server has answered (whatever it said).
   */
  const checkNewerPosition = useCallback(async (signal: AbortSignal): Promise<boolean> => {
    const fetchNewer = latest.current.fetchNewerPosition
    const id = identifierRef.current
    if (!fetchNewer || !id || !scrollRestoredRef.current || latest.current.originalActive) return false
    const newer = await fetchNewer(signal)
    if (newer === null || signal.aborted) return false
    heldOpenRef.current = false // answered: the open is no longer unverified
    if (!newer || identifierRef.current !== id || latest.current.originalActive || explicitRef.current) return true
    const action = decideNewerPosition({
      sameChapter: newer.chapterSlug === id,
      restoreApplied: scrollRestoredRef.current,
      readerMoved: readerMovedSince(baselineRef.current, currentScrollTop(), REFLOW_MOVE_TOLERANCE_PX),
    })
    if (action !== 'move') return true
    const parsed = parseScrollLocator(newer.locator)
    const mounted = mountedEngineFor(id)
    if (!mounted) return true
    const sameSlug = parsed && parsed.slug === id
    // `scroll:<id>:0` with no text position is the chapter's top, a place like any other.
    const at = engineTarget(id, newer.positionJson, sameSlug ? parsed.offset : 0)
      ?? (sameSlug ? { href: id, type: 'text/html', locations: { progression: 0 } } : null)
    if (!at) return true
    // A pending save is this tab's stale place; the newer one is already on the server.
    if (saveTimerRef.current) { clearTimeout(saveTimerRef.current); saveTimerRef.current = null }
    pendingSaveRef.current = null
    await mounted.engine.goTo(at)
    if (identifierRef.current !== id) return true
    setBaseline(currentScrollTop())
    heldOpenRef.current = false
    sessionPositionsRef.current.set(id, { offset: currentScrollTop(), positionJson: newer.positionJson ?? undefined })
    return true
  }, [])

  const { answeredRef } = useNewerPositionCheck(fetchNewerPosition ? checkNewerPosition : undefined, {
    ready: !originalActive && !!chapterIdentifier && restoredFor === chapterIdentifier,
    unanswered: serverUnanswered,
    resetKey: chapterIdentifier,
  })

  // A typography change: the engine's setStyle keeps the place itself (E6); its 'style' relocate is
  // our move, never the reader's (the `relocated` listener above).

  // Save-on-chapter-open: chapter→chapter navigation (route param change;
  // ReaderPage stays mounted) would otherwise record NOTHING for the new chapter
  // until the reader scrolled. Fire exactly ONE save when a chapter opens,
  // sequenced AFTER restore for THIS chapter so the offset is the restored one.
  useEffect(() => {
    if (originalActive || !chapterLoaded || !chapterIdentifier) return
    if (restoredFor !== chapterIdentifier) return
    if (savedOnOpenForRef.current === chapterIdentifier) return
    savedOnOpenForRef.current = chapterIdentifier
    // The open restored from this device's record because the server did not answer: that place
    // is not known to be the latest, so it is not written as if it were. Only THE open — a
    // chapter the reader goes to later is their own choice and saves as usual.
    const isOpen = firstOpenRef.current
    firstOpenRef.current = false
    if (isOpen && serverUnanswered && !answeredRef.current && !explicitRef.current) {
      heldOpenRef.current = true
      return
    }
    writeProgress(chapterIdentifier, currentScrollTop())
  }, [originalActive, chapterIdentifier, chapterLoaded, restoredFor, writeProgress, serverUnanswered, answeredRef])

  // Trailing-debounced save on every scroll — up as well as down. It used to
  // key off overallProgress, which is monotonic (a scroll up never saved), and
  // skipped anything inside 2s of the previous save with no trailing write, so
  // the position the reader actually stopped at was routinely lost (C1).
  useEffect(() => {
    if (!chapterIdentifier) return
    const id = chapterIdentifier
    const onScroll = () => {
      if (!scrollRestoredRef.current || latest.current.originalActive) return
      const top = currentScrollTop()
      const baseline = baselineRef.current
      // The echo of our own scrollTo arrives a frame later: saving it stamped the restored
      // place as the newest write and buried another device's newer row.
      if (baseline != null && Math.abs(top - baseline) < 1) return
      const moved = readerMovedSince(baseline, top, REFLOW_MOVE_TOLERANCE_PX)
      if (heldOpenRef.current) {
        // ponytail: a layout shift above the reading line larger than the tolerance (a big
        // image loading late) still reads as the reader moving and saves the stale local place
        // here. Upgrade path: the server answer / late check, which ends the held open.
        if (!moved) return
        heldOpenRef.current = false
      }
      if (moved) {
        explicitRef.current = false
        readerMovedRef.current = true
      }
      onReaderScrollRef.current?.()
      pendingSaveRef.current = { identifier: id, offset: top }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(writePending, SAVE_DEBOUNCE_MS)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      // Leaving the chapter by any route (TOC, back button): the position the
      // reader left it at is written now, not dropped with the timer.
      writePending()
    }
  }, [chapterIdentifier, writePending])

  // Write the pending position and ship it with keepalive, bypassing both
  // debounces. Called before an in-reader navigation and on hide/unload.
  const flushSave = useCallback(() => {
    writePending()
    if (latest.current.mode === 'public') latest.current.publicProgress.flushSave()
    else latest.current.userProgress.flushSave()
  }, [writePending])

  // Flush on visibility hidden / pagehide / unmount. Stable deps: runs once. (The re-check on
  // visible lives in useNewerPositionCheck.)
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushSave()
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flushSave)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flushSave)
      flushSave()
    }
  }, [flushSave])

  return { flushSave, markPositioned }
}
