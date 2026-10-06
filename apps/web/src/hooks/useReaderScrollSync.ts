import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildTextPosition, parseScrollLocator, parseTextPosition, resolveTextPosition,
  serializeTextPosition, decideNewerPosition, readerMovedSince, REFLOW_MOVE_TOLERANCE_PX,
  type ResolvedPosition,
} from '@textstack/shared'
import { PROGRESS_GET_TIMEOUT_MS, PROGRESS_LATE_CHECK_TIMEOUT_MS } from '../lib/progressSync'
import type { NewerPositionResult } from './useReaderProgress'
import { readReadingLine, rangeAtCharOffset, articleText } from '../lib/textAnchor'
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
   * Identity of the typography currently applied. Changing it reflows the text,
   * which is the one thing that silently invalidates a pixel scroll position —
   * and this hook had no idea it ever happened.
   */
  settingsKey: string
  /**
   * A `?highlight=` link is positioning the reader. Restore and save-on-open
   * wait: the link either lands (markPositioned) or gives up, and only then
   * does the normal restore run.
   */
  holdRestore?: boolean
  /** The hold hit its deadline (HOLD_DEADLINE_MS after the chapter is ready) and was dropped. */
  onHoldExpired?: () => void
  /**
   * The restore used this device's record because the server did not answer in time. The
   * server is re-asked once in the background, and the save-on-open waits for that answer: it
   * would stamp the stale local place as the newest write and bury another device's.
   */
  serverTimedOut?: boolean
  /** Re-ask the server for a provably newer position (useReaderProgress). */
  fetchNewerPosition?: (timeoutMs: number) => Promise<NewerPositionResult>
}


/**
 * A quarter down the viewport — the same probe the mobile reader measures
 * against, so a position captured on one client describes the same place on the
 * other.
 */
const READING_LINE_FRACTION = 0.25

/** The rendered chapter. Web mounts exactly one per route (see ReaderPage). */
function readerArticle(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.reader-section__article')
}

/** Where to scroll so a resolved position sits on the reading line. */
function anchoredScrollTop(article: HTMLElement | null, resolved: ResolvedPosition | null): number | null {
  if (!article || !resolved) return null
  if (resolved.kind === 'fraction') {
    const height = document.documentElement.scrollHeight - window.innerHeight
    return height > 0 ? Math.round(height * resolved.fraction) : 0
  }
  const range = rangeAtCharOffset(article, resolved.offset)
  if (!range) return null
  const rect = range.getBoundingClientRect()
  const scrollTop = (document.scrollingElement || document.documentElement).scrollTop
  return Math.max(0, Math.round(scrollTop + rect.top - window.innerHeight * READING_LINE_FRACTION))
}

/** The position at the reading line right now, serialised, or null. */
function captureReadingPosition(chapterSlug: string): string | null {
  const article = readerArticle()
  if (!article) return null
  const line = readReadingLine(article, window.innerHeight * READING_LINE_FRACTION)
  if (!line) return null
  const height = document.documentElement.scrollHeight - window.innerHeight
  const scrollTop = (document.scrollingElement || document.documentElement).scrollTop
  return serializeTextPosition(buildTextPosition({
    chapterSlug,
    chapterText: line.chapterText,
    charOffset: line.charOffset,
    chapterFraction: height > 0 ? Math.min(1, Math.max(0, scrollTop / height)) : 0,
  }))
}

/**
 * Trailing debounce for the scroll save. The last position the reader stopped
 * at is the one that counts; hide / pagehide / unmount / chapter change flush
 * it at once. The progress hooks add their own 2s server debounce on top.
 */
const SAVE_DEBOUNCE_MS = 1500

/** How long a typography change keeps re-anchoring on article resizes (webfont swap). */
const REFLOW_SETTLE_MS = 1000

/** A ?highlight= link may hold restore this long after the chapter is ready, no longer. */
const HOLD_DEADLINE_MS = 5000

/** Scroll pause after which the reading line is remembered for a later reflow. */
const LINE_IDLE_MS = 150

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
  settingsKey,
  holdRestore = false,
  onHoldExpired,
  serverTimedOut = false,
  fetchNewerPosition,
}: Params) {
  const scrollRestoredRef = useRef(false)
  // The reading line as of the last scroll pause. The live capture reads the
  // line by hit-testing, and the settings drawer — where every typography
  // change is made — covers it, so the live read finds nothing there.
  const lastLineRef = useRef<string | null>(null)
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
  // Where the last restore or save left the reader in the current chapter. A newer position from
  // another device may move the reader only while they are still here (readerMovedSince).
  const baselineRef = useRef<number | null>(null)

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
    if (identifier === identifierRef.current) baselineRef.current = offset

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

  // Reset restore guard on chapter change.
  useEffect(() => {
    scrollRestoredRef.current = false
    setRestoredFor(null)
  }, [chapterIdentifier])

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

    // The text anchor first: it is the only one of the two that is still true
    // after the text has reflowed — a font size change here, a different screen
    // width, a re-parsed book, or simply the phone this was last read on. The
    // pixel offset below is what a row written by an older build has to offer,
    // and is parsed with the SHARED parser rather than the split(':') this used
    // to do inline: a chapter slug containing a colon made that return the wrong
    // slug and an offset of 0.
    const article = readerArticle()
    const anchored = article
      ? resolveTextPosition(
          parseTextPosition(positionJson),
          chapterIdentifier ?? null,
          articleText(article),
        )
      : null

    const parsed = parseScrollLocator(effectiveProgress?.locator)
    const savedOffset = session
      ? session.offset
      : parsed && parsed.slug === chapterIdentifier ? parsed.offset : 0

    const forId = chapterIdentifier
    requestAnimationFrame(() => {
      // The chapter changed before this frame: this restore is for a page that
      // is no longer the one on screen.
      if (identifierRef.current !== forId) return
      const top = anchoredScrollTop(article, anchored) ?? savedOffset
      window.scrollTo({ top, behavior: 'instant' })
      baselineRef.current = top
      scrollRestoredRef.current = true
      setRestoredFor(forId ?? null)
      if (forId) lastLineRef.current = captureReadingPosition(forId)
    })
  }, [originalActive, chapterLoaded, effectiveLoading, effectiveProgress, chapterIdentifier, held])

  /** Something else (a `?highlight=` jump) positioned the reader: treat it as the restore. */
  const markPositioned = useCallback(() => {
    const id = identifierRef.current
    if (!id) return
    scrollRestoredRef.current = true
    setRestoredFor(id)
    baselineRef.current = currentScrollTop()
    lastLineRef.current = captureReadingPosition(id)
  }, [])

  /**
   * Ask the server whether another device recorded a newer place, and go there if the reader
   * has not moved since the last restore or save. Mobile's rules (decideNewerPosition), minus
   * the prompt: web never asks and never leaves the chapter — the reader's next scroll decides.
   * Resolves true once the server has answered (whatever it said).
   */
  const checkNewerPosition = useCallback(async (timeoutMs: number): Promise<boolean> => {
    const fetchNewer = latest.current.fetchNewerPosition
    const id = identifierRef.current
    if (!fetchNewer || !id || !scrollRestoredRef.current || latest.current.originalActive) return false
    const newer = await fetchNewer(timeoutMs)
    if (newer === null) return false
    if (!newer || identifierRef.current !== id || latest.current.originalActive) return true
    const action = decideNewerPosition({
      sameChapter: newer.chapterSlug === id,
      restoreApplied: scrollRestoredRef.current,
      readerMoved: readerMovedSince(baselineRef.current, currentScrollTop(), REFLOW_MOVE_TOLERANCE_PX),
    })
    if (action !== 'move') return true
    const article = readerArticle()
    const anchored = article
      ? resolveTextPosition(parseTextPosition(newer.positionJson), id, articleText(article))
      : null
    const parsed = parseScrollLocator(newer.locator)
    const top = anchoredScrollTop(article, anchored) ?? (parsed && parsed.slug === id ? parsed.offset : null)
    if (top == null) return true
    window.scrollTo({ top, behavior: 'instant' })
    baselineRef.current = top
    sessionPositionsRef.current.set(id, { offset: top, positionJson: newer.positionJson ?? undefined })
    lastLineRef.current = captureReadingPosition(id)
    return true
  }, [])

  // The restore did not wait for the server: re-ask once, in the background. Re-runs when the
  // fetcher changes (auth settled) until the server has answered.
  const lateCheckSettledRef = useRef(false)
  useEffect(() => {
    if (!serverTimedOut) { lateCheckSettledRef.current = false; return }
    if (lateCheckSettledRef.current || !chapterIdentifier || restoredFor !== chapterIdentifier) return
    void checkNewerPosition(PROGRESS_LATE_CHECK_TIMEOUT_MS).then((settled) => {
      if (settled) lateCheckSettledRef.current = true
    })
  }, [serverTimedOut, restoredFor, chapterIdentifier, fetchNewerPosition, checkNewerPosition])

  /**
   * Keep the reader in place when the text reflows under them.
   *
   * The anchor must be read from the OLD layout. An effect runs after the new
   * inline styles are committed, so any measurement there already sees the
   * reflowed text and records whatever now sits on the reading line (H2) — so
   * the settings update path calls `captureBeforeReflow()` first, and this
   * effect only restores. It restores at once (the measurement forces the new
   * layout) and again on every article resize for a short window, because a
   * font-family change keeps reflowing until the webfont lands.
   */
  const reflowAnchorRef = useRef<string | null>(null)
  const captureBeforeReflow = useCallback(() => {
    const id = identifierRef.current
    reflowAnchorRef.current = id && !latest.current.originalActive && scrollRestoredRef.current
      ? captureReadingPosition(id) ?? lastLineRef.current
      : null
  }, [])

  useEffect(() => {
    const before = reflowAnchorRef.current
    reflowAnchorRef.current = null
    if (!before || originalActive || !chapterLoaded || !chapterIdentifier) return
    if (restoredFor !== chapterIdentifier) return
    const article = readerArticle()
    if (!article) return

    const reanchor = () => {
      const resolved = resolveTextPosition(parseTextPosition(before), chapterIdentifier, articleText(article))
      const top = anchoredScrollTop(article, resolved)
      if (top != null) window.scrollTo({ top, behavior: 'instant' })
    }
    reanchor()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(reanchor)
    observer.observe(article)
    const stop = window.setTimeout(() => observer.disconnect(), REFLOW_SETTLE_MS)
    return () => { observer.disconnect(); clearTimeout(stop) }
  }, [settingsKey, originalActive, chapterLoaded, chapterIdentifier, restoredFor])

  // Save-on-chapter-open: chapter→chapter navigation (route param change;
  // ReaderPage stays mounted) would otherwise record NOTHING for the new chapter
  // until the reader scrolled. Fire exactly ONE save when a chapter opens,
  // sequenced AFTER restore for THIS chapter so the offset is the restored one.
  useEffect(() => {
    if (originalActive || !chapterLoaded || !chapterIdentifier) return
    if (restoredFor !== chapterIdentifier) return
    if (savedOnOpenForRef.current === chapterIdentifier) return
    savedOnOpenForRef.current = chapterIdentifier
    // Opened from this device's record because the server was too slow: this place is not known
    // to be the latest, so it is not written as if it were. The reader's first scroll saves.
    if (serverTimedOut && !lateCheckSettledRef.current) return
    writeProgress(chapterIdentifier, currentScrollTop())
  }, [originalActive, chapterIdentifier, chapterLoaded, restoredFor, writeProgress, serverTimedOut])

  // Trailing-debounced save on every scroll — up as well as down. It used to
  // key off overallProgress, which is monotonic (a scroll up never saved), and
  // skipped anything inside 2s of the previous save with no trailing write, so
  // the position the reader actually stopped at was routinely lost (C1).
  useEffect(() => {
    if (!chapterIdentifier) return
    const id = chapterIdentifier
    lastLineRef.current = null
    let lineTimer: number | undefined
    const rememberLine = () => {
      const line = captureReadingPosition(id)
      if (line) lastLineRef.current = line
    }
    const onScroll = () => {
      if (!scrollRestoredRef.current || latest.current.originalActive) return
      clearTimeout(lineTimer)
      lineTimer = window.setTimeout(rememberLine, LINE_IDLE_MS)
      pendingSaveRef.current = { identifier: id, offset: currentScrollTop() }
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(writePending, SAVE_DEBOUNCE_MS)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      clearTimeout(lineTimer)
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

  // Flush on visibility hidden / pagehide / unmount. Stable deps: runs once.
  // Back to a tab left open: another device may have read on since, and this tab's first scroll
  // would write its stale place over that (bug R4-4). Re-ask, bounded like the open.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushSave()
      else if (document.visibilityState === 'visible') void checkNewerPosition(PROGRESS_GET_TIMEOUT_MS)
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', flushSave)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', flushSave)
      flushSave()
    }
  }, [flushSave, checkNewerPosition])

  return { flushSave, captureBeforeReflow, markPositioned }
}
