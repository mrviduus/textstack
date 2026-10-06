import { useRef, useCallback } from 'react'
import type { Location, NavigateFunction } from 'react-router-dom'
import { useReaderScrollSync, isChapterReady } from './useReaderScrollSync'
import type { UseReaderProgressResult } from './useReaderProgress'
import type { useReaderSettings } from './useReaderSettings'
import type { BookDetail } from '../types/api'
import type { ReaderMode, NormalizedChapter } from './useReaderChapter'

interface Params {
  mode: ReaderMode
  publicBook: BookDetail | null
  chapter: NormalizedChapter | null
  /** The URL's chapter. */
  chapterIdentifier: string | undefined
  loading: boolean
  originalActive: boolean
  overallProgress: number
  progress: UseReaderProgressResult
  settings: ReturnType<typeof useReaderSettings>['settings']
  /** Live `?highlight=` param. */
  scrollToHighlightId: string | null
  highlightsLoaded: boolean
  authLoading: boolean
  onReaderScroll: () => void
  location: Location
  navigate: NavigateFunction
}

/**
 * ReaderPage's progress/restore wiring: scroll restore + save (useReaderScrollSync)
 * and the `?highlight=` link that holds both until it has positioned the reader.
 */
export function useReaderPositionSync({
  mode,
  publicBook,
  chapter,
  chapterIdentifier,
  loading,
  originalActive,
  overallProgress,
  progress,
  settings,
  scrollToHighlightId,
  highlightsLoaded,
  authLoading,
  onReaderScroll,
  location,
  navigate,
}: Params) {
  const { publicProgress, userProgress, effectiveProgress, effectiveLoading, serverUnanswered, fetchNewerPosition } = progress

  // Scroll-position restore + debounced save + flush on visibility/unload.
  // flushProgress ships the LEAVING chapter's latest scroll before a
  // same-component route change (ReaderPage stays mounted, so no unmount flush).
  const { flushSave: flushProgress, captureBeforeReflow, markPositioned } = useReaderScrollSync({
    mode,
    chapterIdentifier,
    chapterLoaded: isChapterReady(chapter, chapterIdentifier, loading),
    // An uploaded PDF usually HAS reflow chapters, so the chapter fetch succeeds
    // in Original layout too and the save-on-open would fire while the reader is
    // looking at pages. Same defect the mobile reader had.
    originalActive,
    overallProgress,
    effectiveProgress,
    effectiveLoading,
    publicBookChapters: publicBook?.chapters,
    publicProgress,
    userProgress,
    // Typography only. Theme is a data-attribute swap and does not re-wrap text,
    // so re-anchoring for it would cost a layout read for nothing.
    settingsKey: `${settings.fontSize} ${settings.lineHeight} ${settings.fontFamily} ${settings.textAlign}`,
    // A ?highlight= link positions the reader; restore and save-on-open wait for it.
    holdRestore: !!scrollToHighlightId && !originalActive,
    onHoldExpired: () => handleHighlightLinkDoneRef.current(false),
    serverUnanswered,
    fetchNewerPosition,
    // A TOC open names its place: a newer position from elsewhere never replaces it.
    explicitOpen: new URLSearchParams(location.search).get('direct') === '1',
    onReaderScroll,
  })

  // ?highlight= resolved: landed → that is the restored position; not found →
  // the held restore runs. Either way the param goes (replace), so Back and
  // reload restore normally instead of jumping again.
  const highlightLinkReady = highlightsLoaded && !authLoading
    && (originalActive || isChapterReady(chapter, chapterIdentifier, loading))
  const handleHighlightLinkDone = useCallback((found: boolean) => {
    if (found) markPositioned()
    const sp = new URLSearchParams(location.search)
    sp.delete('highlight')
    const q = sp.toString()
    navigate({ pathname: location.pathname, search: q ? `?${q}` : '', hash: location.hash }, { replace: true, state: location.state })
  }, [markPositioned, location, navigate])
  const handleHighlightLinkDoneRef = useRef(handleHighlightLinkDone)
  handleHighlightLinkDoneRef.current = handleHighlightLinkDone

  return { flushProgress, captureBeforeReflow, highlightLinkReady, handleHighlightLinkDone }
}
