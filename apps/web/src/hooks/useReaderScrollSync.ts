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

const SAVE_DEBOUNCE_MS = 600
const SAVE_SKIP_WINDOW_MS = 2000

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
  const lastSaveRef = useRef<{ identifier: string; offset: number; timestamp: number } | null>(null)
  const saveTimerRef = useRef<number | null>(null)
  const pendingSaveRef = useRef<{ identifier: string; offset: number; progress: number } | null>(null)
  // State-backed mirror of scrollRestoredRef so the save-on-open effect can
  // re-run AFTER restore completes (a ref flip won't trigger a re-render).
  // Keyed by the chapter identifier that was restored.
  const [restoredFor, setRestoredFor] = useState<string | null>(null)
  // Guard: emit exactly one save-on-open per opened chapter.
  const savedOnOpenForRef = useRef<string | null>(null)

  /**
   * The one place a reading position is written.
   *
   * There used to be three copies of this — save-on-open, the debounced scroll
   * save, and the keepalive flush — each building the locator itself and each
   * branching on mode. Adding the text position to three copies is how a fourth
   * field ends up in two of them.
   *
   * Returns whether anything was written, so the flush knows whether to follow
   * it with a keepalive.
   */
  const writeProgress = useCallback((identifier: string, offset: number, progress: number): boolean => {
    const locator = `scroll:${identifier}:${Math.round(offset)}`
    // Captured at write time from the live DOM, so it describes the same instant
    // the offset does. Null when the reading line has no text under it — a
    // margin, a gap, an image — and the locator then travels alone.
    const positionJson = captureReadingPosition(identifier) ?? undefined

    if (mode === 'public') {
      const bookChapter = publicBookChapters?.find(c => c.slug === identifier)
      if (!bookChapter) return false
      publicProgress.updateProgress(progress, undefined, locator, bookChapter.id, identifier, positionJson)
      return true
    }
    userProgress.saveProgress(identifier, 0, progress, locator, positionJson)
    return true
  }, [mode, publicBookChapters, publicProgress, userProgress])

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
          parseTextPosition(effectiveProgress?.positionJson),
          chapterIdentifier ?? null,
          articleText(article),
        )
      : null

    const parsed = parseScrollLocator(effectiveProgress?.locator)
    const savedOffset = parsed && parsed.slug === chapterIdentifier ? parsed.offset : 0

    requestAnimationFrame(() => {
      const top = anchoredScrollTop(article, anchored) ?? savedOffset
      window.scrollTo({ top, behavior: 'instant' })
      scrollRestoredRef.current = true
      setRestoredFor(chapterIdentifier ?? null)
    })
  }, [originalActive, chapterLoaded, effectiveLoading, effectiveProgress, chapterIdentifier])

  /**
   * Keep the reader in place when the text reflows under them.
   *
   * Web applies typography as inline styles on the article, so there is no
   * remount and no restore — `scrollRestoredRef` is already true and only a
   * chapter change clears it. The text simply re-wrapped under a fixed
   * `scrollTop`, and the debounced save then wrote the drifted position. Nothing
   * in this hook has ever depended on `settings`; that absence WAS the bug.
   *
   * The position is captured before the browser has re-laid-out (this effect
   * runs in the same commit as the style change) and re-applied once the article
   * actually resizes — a ResizeObserver is the only reliable signal that the
   * reflow has landed, since a style change fires no resize event on window.
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
      if (top != null) {
        window.scrollTo({ top, behavior: 'instant' })
        // The save that would otherwise fire for the transient position is not
        // ours to make — re-prime the skip window so the scroll listener treats
        // this as already saved.
        lastSaveRef.current = { identifier: chapterIdentifier, offset: top, timestamp: Date.now() }
      }
    })
    observer.observe(article)
    // A settings change that does not resize the article (a theme swap) leaves
    // the observer waiting; drop it on the next change rather than leak it.
    return () => observer.disconnect()
  }, [settingsKey, originalActive, chapterLoaded, chapterIdentifier, restoredFor])

  // Save-on-chapter-open: the debounced scroll save is gated by user scrolling,
  // so chapter→chapter navigation (route param change; ReaderPage stays mounted)
  // recorded NOTHING for the new chapter — MaxChapterNumber stayed unset and the
  // book indicator showed "0 / N". Fire exactly ONE save when a chapter opens,
  // sequenced AFTER restore so the offset reflects the restored scroll, not a
  // transient 0. Uses the current chapter's id + book-level overallProgress.
  useEffect(() => {
    if (originalActive || !chapterLoaded || !chapterIdentifier) return
    // Wait until restore has run for THIS chapter (offset is settled).
    if (restoredFor !== chapterIdentifier) return
    if (savedOnOpenForRef.current === chapterIdentifier) return
    savedOnOpenForRef.current = chapterIdentifier

    const offset = (document.scrollingElement || document.documentElement).scrollTop

    // Prime the dedupe/skip refs so the next scroll-debounced save doesn't
    // immediately re-fire an identical write for the same chapter.
    lastSaveRef.current = { identifier: chapterIdentifier, offset, timestamp: Date.now() }
    pendingSaveRef.current = { identifier: chapterIdentifier, offset, progress: overallProgress }

    writeProgress(chapterIdentifier, offset, overallProgress)
    // overallProgress intentionally excluded: we snapshot it on open only. The
    // scroll-debounced effect owns continuous updates as the user reads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalActive, chapterIdentifier, chapterLoaded, mode, restoredFor, publicBookChapters, publicProgress, userProgress])

  // Flush pending save now: write locally + ask the underlying hook to ship
  // synchronously (keepalive fetch) so we don't lose the write on tab death.
  const flushSave = useCallback(() => {
    // Same rule as the two effects above: a PDF viewer's position is not ours
    // to write, and this one fires on tab close with keepalive — the write most
    // likely to be the last one the server sees.
    if (originalActive) return
    const pending = pendingSaveRef.current
    if (!pending) return

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }

    const { identifier, offset, progress } = pending
    if (writeProgress(identifier, offset, progress)) {
      if (mode === 'public') publicProgress.flushSave()
      else userProgress.flushSave()
    }

    pendingSaveRef.current = null
  }, [originalActive, mode, publicBookChapters, publicProgress, userProgress])

  // Debounced save on scroll position change. The save effect keys off
  // overallProgress so it re-runs when chapter scroll moves.
  useEffect(() => {
    if (!scrollRestoredRef.current) return
    const visibleId = chapterIdentifier
    if (!visibleId) return

    const offset = (document.scrollingElement || document.documentElement).scrollTop
    const now = Date.now()
    const last = lastSaveRef.current
    const chapterChanged = !last || last.identifier !== visibleId
    if (!chapterChanged && last && (now - last.timestamp) < SAVE_SKIP_WINDOW_MS) return

    lastSaveRef.current = { identifier: visibleId, offset, timestamp: now }
    pendingSaveRef.current = { identifier: visibleId, offset, progress: overallProgress }

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    const saveId = visibleId
    const saveOffset = offset
    const saveProgress = overallProgress

    saveTimerRef.current = window.setTimeout(() => {
      writeProgress(saveId, saveOffset, saveProgress)
      pendingSaveRef.current = null
      saveTimerRef.current = null
    }, SAVE_DEBOUNCE_MS)
  }, [originalActive, mode, publicBookChapters, chapterIdentifier, overallProgress, publicProgress, userProgress])

  // Flush on visibility hidden / beforeunload / unmount.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushSave()
    }
    const onBeforeUnload = () => flushSave()

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('beforeunload', onBeforeUnload)

    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('beforeunload', onBeforeUnload)
      flushSave()
    }
  }, [flushSave])
}
