import { useEffect, useRef } from 'react'
import { useLibrary } from './useLibrary'
import { useGuestLimits } from '../context/GuestLimitsContext'
import type { ReaderMode, NormalizedBook } from './useReaderChapter'

interface Params {
  mode: ReaderMode
  book: NormalizedBook | null
  bookSlug: string | undefined
  /** The URL's chapter. */
  chapterIdentifier: string | undefined
  isAuthenticated: boolean
  overallProgress: number
  /** A state setter: stable, so it never re-runs the add. */
  showToast: (message: string) => void
}

/**
 * ReaderPage's library bookkeeping: remember the open book for a returning guest,
 * and add a catalog book to the library once the reader is 1% in.
 */
export function useReaderLibraryTracking({ mode, book, bookSlug, chapterIdentifier, isAuthenticated, overallProgress, showToast }: Params) {
  // /me/library holds editions only; an upload is already the reader's own.
  const { add: addToLibrary, isInLibrary } = useLibrary({ enabled: mode === 'public' })
  const { setCurrentBook: setGuestCurrentBook } = useGuestLimits()
  const libraryAddedRef = useRef(false)

  // Track current book for guest returning user feature
  useEffect(() => {
    if (isAuthenticated || !bookSlug || !chapterIdentifier) return
    setGuestCurrentBook({ bookSlug, chapterSlug: chapterIdentifier })
  }, [isAuthenticated, bookSlug, chapterIdentifier, setGuestCurrentBook])

  // Auto-add to library after 1% overall progress
  useEffect(() => {
    if (mode !== 'public' || !book?.id || libraryAddedRef.current) return
    if (overallProgress < 0.01) return
    if (isInLibrary(book.id)) {
      libraryAddedRef.current = true
      return
    }
    libraryAddedRef.current = true
    addToLibrary(book.id)
      .then(() => showToast('Added to library'))
      .catch(() => {}) // silent fail
  }, [mode, overallProgress, book?.id, isInLibrary, addToLibrary, showToast])
}
