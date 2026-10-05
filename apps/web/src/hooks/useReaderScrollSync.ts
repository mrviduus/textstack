import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildTextPosition, parseScrollLocator, parseTextPosition, resolveTextPosition,
  serializeTextPosition, type ResolvedPosition,
} from '@textstack/shared'
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
  const latest = useRef({ mode, originalActive, overallProgress, publicBookChapters, publicProgress, userProgress, chapterLoaded })
  latest.current = { mode, originalActive, overallProgress, publicBookChapters, publicProgress, userProgress, chapterLoaded }

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

  // Reset restore guard on chapter change.
  useEffect(() => {
    scrollRestoredRef.current = false
    setRestoredFor(null)
  }, [chapterIdentifier])

  // Restore scroll: locator must match current chapter. Otherwise scroll to
  // top — React Router preserves scrollY across route changes, so without
  // this, hitting "Next" at the bottom of ch1 leaves you mid-/end-of ch2.
  useEffect(() => {
    if (scrollRestoredRef.current || effectiveLoading) return
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
      scrollRestoredRef.current = true
      setRestoredFor(forId ?? null)
    })
  }, [originalActive, chapterLoaded, effectiveLoading, effectiveProgress, chapterIdentifier])

  /**
   * Keep the reader in place when the text reflows under them.
   *
   * Web applies typography as inline styles on the article, so there is no
   * remount and no restore. The position is captured before the browser has
   * re-laid-out (this effect runs in the same commit as the style change) and
   * re-applied once the article actually resizes — a ResizeObserver is the only
   * reliable signal that the reflow has landed. The re-anchoring scrollTo fires
   * a scroll event, so the trailing save then records the corrected position.
   */
  useEffect(() => {
    if (originalActive || !chapterLoaded || !chapterIdentifier) return
    if (restoredFor !== chapterIdentifier) return
    const article = readerArticle()
    if (!article || typeof ResizeObserver === 'undefined') return

    const before = captureReadingPosition(chapterIdentifier)
    if (!before) return

    let done = false
    const observer = new ResizeObserver(() => {
      if (done) return
      done = true
      observer.disconnect()
      const resolved = resolveTextPosition(parseTextPosition(before), chapterIdentifier, articleText(article))
      const top = anchoredScrollTop(article, resolved)
      if (top != null) window.scrollTo({ top, behavior: 'instant' })
    })
    observer.observe(article)
    // A settings change that does not resize the article (a theme swap) leaves
    // the observer waiting; drop it on the next change rather than leak it.
    return () => observer.disconnect()
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
    writeProgress(chapterIdentifier, currentScrollTop())
  }, [originalActive, chapterIdentifier, chapterLoaded, restoredFor, writeProgress])

  // Trailing-debounced save on every scroll — up as well as down. It used to
  // key off overallProgress, which is monotonic (a scroll up never saved), and
  // skipped anything inside 2s of the previous save with no trailing write, so
  // the position the reader actually stopped at was routinely lost (C1).
  useEffect(() => {
    if (!chapterIdentifier) return
    const id = chapterIdentifier
    const onScroll = () => {
      if (!scrollRestoredRef.current || latest.current.originalActive) return
      pendingSaveRef.current = { identifier: id, offset: currentScrollTop() }
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

  // Flush on visibility hidden / pagehide / unmount. Stable deps: runs once.
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

  return { flushSave }
}
