import { useEffect, useRef, useCallback, useMemo } from 'react'
import { bookMinutesLeft } from '@textstack/shared'
import { useReadingSession } from './useReadingSession'
import { useQuickStats } from './useQuickStats'
import { useReadingPace } from './useReadingPace'
import { formatEtf } from '../lib/timeEstimate'
import { trackBookOpened } from '../lib/analytics'
import type { BookDetail } from '../types/api'
import type { ReaderMode, NormalizedBook } from './useReaderChapter'

interface Params {
  mode: ReaderMode
  /** Upload id from the route (`:id`). */
  id: string | undefined
  publicBook: BookDetail | null
  book: NormalizedBook | null
  overallProgress: number
  isAuthenticated: boolean
  /** UI language from the route. */
  language: string
}

/**
 * ReaderPage's reading-session tracking (time, words), the book-opened analytics
 * event and the stats widget's numbers (quick stats, time left in the book).
 */
export function useReaderSessionTracking({ mode, id, publicBook, book, overallProgress, isAuthenticated, language }: Params) {
  // Reading session tracking (time, words)
  const readingSession = useReadingSession({
    editionId: mode === 'public' ? publicBook?.id : undefined,
    userBookId: mode === 'userbook' ? id : undefined,
    totalWords: mode === 'public' && publicBook
      ? publicBook.chapters.reduce((sum, c) => sum + (c.wordCount || 0), 0)
      : undefined,
    startPercent: overallProgress,
    isAuthenticated,
  })

  // Sync percent to reading session tracker
  useEffect(() => {
    readingSession.updatePercent(overallProgress)
  }, [overallProgress, readingSession])

  // GA4: fire once per mount when the book is first resolved. Keyed on
  // editionId/userBookId so a re-mount on navigation fires again, but
  // re-renders within the same open don't double-count.
  const bookOpenedFiredRef = useRef<string | null>(null)
  useEffect(() => {
    const editionId = mode === 'public' ? publicBook?.id : undefined
    const userBookId = mode === 'userbook' ? id : undefined
    const key = editionId || userBookId
    if (!key) return
    if (bookOpenedFiredRef.current === key) return
    bookOpenedFiredRef.current = key
    trackBookOpened({
      source: mode === 'public' ? 'library' : 'userbook',
      editionId: editionId || null,
      userBookId: userBookId || null,
      // NormalizedBook doesn't carry language; fall back to the UI language
      // from the route, which is the same locale the reader is rendered in.
      language: mode === 'public' ? publicBook?.language : language,
    })
  }, [mode, publicBook?.id, publicBook?.language, id, language])

  // ETF & reader stats
  const quickStats = useQuickStats()
  // Same pace rule as library cards and mobile: personal wpm, else 200.
  const { wpm } = useReadingPace()

  const bookTotalWords = useMemo(() => {
    if (mode === 'public' && publicBook) {
      return publicBook.chapters.reduce((sum, c) => sum + (c.wordCount || 0), 0)
    }
    if (mode === 'userbook' && book) {
      return book.totalWordCount || book.chapters.reduce((sum: number, c: any) => sum + (c.wordCount || 0), 0)
    }
    return 0
  }, [mode, publicBook, book])

  const bookEtf = useMemo(
    () => {
      const minutes = bookMinutesLeft(bookTotalWords, overallProgress, wpm)
      return minutes ? formatEtf(minutes) : null
    },
    [bookTotalWords, overallProgress, wpm],
  )

  // Reading-session activity from the reader's OWN scrolls (useReaderScrollSync filters out
  // the restore's echo). A window listener here used to count the restore as the session's first
  // activity, before its progress landed — so the restored offset was counted as words read.
  const lastActivityScrollRef = useRef(0)
  const onReaderScroll = useCallback(() => {
    const now = Date.now()
    if (now - lastActivityScrollRef.current > 5000) { // throttle: once per 5s
      lastActivityScrollRef.current = now
      readingSession.recordActivity()
    }
  }, [readingSession])

  return { readingSession, quickStats, bookEtf, onReaderScroll }
}
