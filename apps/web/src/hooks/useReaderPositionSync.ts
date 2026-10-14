import { useRef, useCallback } from 'react'
import type { Location, NavigateFunction } from 'react-router-dom'
import { useReaderScrollSync, isChapterReady } from './useReaderScrollSync'
import type { UseReaderProgressResult } from './useReaderProgress'
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
  /** The chapter whose engine open has landed (ReaderSection's onEngineOpened). */
  engineOpenedFor: string | null
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
  engineOpenedFor,
  scrollToHighlightId,
  highlightsLoaded,
  authLoading,
  onReaderScroll,
  location,
  navigate,
}: Params) {
  // The chapter is ready once the engine's open has landed: restore, a `?highlight=` jump and
  // save-on-open never race the open's own landing at the top.
  const chapterReady = isChapterReady(chapter, chapterIdentifier, loading)
    && engineOpenedFor === chapterIdentifier
  const { publicProgress, userProgress, effectiveProgress, effectiveLoading, serverUnanswered, fetchNewerPosition } = progress

  // Scroll-position restore + debounced save + flush on visibility/unload.
  // flushProgress ships the LEAVING chapter's latest scroll before a
  // same-component route change (ReaderPage stays mounted, so no unmount flush).
  const { flushSave: flushProgress, markPositioned } = useReaderScrollSync({
    mode,
    chapterIdentifier,
    chapterLoaded: chapterReady,
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
    && (originalActive || chapterReady)
  const handleHighlightLinkDone = useCallback((found: boolean) => {
    if (found) markPositioned()
    const sp = new URLSearchParams(location.search)
    sp.delete('highlight')
    const q = sp.toString()
    navigate({ pathname: location.pathname, search: q ? `?${q}` : '', hash: location.hash }, { replace: true, state: location.state })
  }, [markPositioned, location, navigate])
  const handleHighlightLinkDoneRef = useRef(handleHighlightLinkDone)
  handleHighlightLinkDoneRef.current = handleHighlightLinkDone

  return { flushProgress, highlightLinkReady, handleHighlightLinkDone }
}
