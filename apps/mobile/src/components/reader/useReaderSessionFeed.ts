import { useEffect, useState, useRef, useCallback } from 'react'
import type { MutableRefObject } from 'react'
import { computeBookProgress } from '@textstack/shared'
import { latchChapterEnd } from '../../lib/firstRun'
import type { useReadingSession } from '../../hooks/useReadingSession'
import type { ReaderShellProps } from './readerShellTypes'

type Args = Pick<ReaderShellProps,
  | 'chapters' | 'chapterSlug' | 'original' | 'positionSettled' | 'sessionJumpRef' | 'onRestoreLanded' | 'bumpProgress'
  | 'progressRef' | 'scrollOffsetRef' | 'positionRef' | 'currentChapterSlugRef' | 'bookProgressRef' | 'totalWordCountRef'
> & {
  finishedChapterRef: MutableRefObject<boolean>
  updateSessionProgress: ReturnType<typeof useReadingSession>['updateProgress']
  recordSessionActivity: () => void
}

/**
 * The reflow WebView's position reports — 'progress' and the restore ack 'restored' — turned into
 * chapter and book progress, and fed to the reading session once the restore has settled (M8).
 */
export function useReaderSessionFeed({
  chapters, chapterSlug, original, positionSettled, sessionJumpRef, onRestoreLanded, bumpProgress,
  progressRef, scrollOffsetRef, positionRef, currentChapterSlugRef, bookProgressRef, totalWordCountRef,
  finishedChapterRef, updateSessionProgress, recordSessionActivity,
}: Args) {
  const [progress, setProgress] = useState(0)
  const [bookProgress, setBookProgress] = useState<number | null>(null)
  const updateBookProgress = (slug: string | null, chapterProgress: number) => {
    const bp = computeBookProgress(chapters, slug, chapterProgress, totalWordCountRef.current)
    bookProgressRef.current = bp
    setBookProgress(bp)
    return bp
  }

  // M8: the session counts reading, not the restore. Until this chapter's position has settled,
  // a report is the load event's chapter top or the restore travelling — fed to the session, it
  // became the start percent and the jump to the saved place was counted as words read.
  // Set by the WebView's own `restored` ack (its message order puts it before the restore
  // scroll's report), or by the persistence gate when there was nothing to restore.
  const sessionSettledRef = useRef(false)
  useEffect(() => {
    if (!positionSettled || sessionSettledRef.current) return
    sessionSettledRef.current = true
    if (!original && bookProgressRef.current != null) updateSessionProgress(bookProgressRef.current)
  }, [positionSettled, original, bookProgressRef, updateSessionProgress])

  /** True when the message was 'progress' or 'restored'. */
  const onMessage = useCallback((data: any): boolean => {
    if (data.type === 'progress') {
      progressRef.current = data.progress
      if (typeof data.scrollY === 'number') scrollOffsetRef.current = data.scrollY
      // Null when the reading line had no text under it — a margin, a gap
      // between paragraphs, an image. Keep the previous one rather than
      // blanking a good position for a scroll that passed over a picture;
      // saveProgress checks the chapter before it uses it.
      if (data.position) positionRef.current = data.position
      setProgress(data.progress)
      if (data.chapterSlug) currentChapterSlugRef.current = data.chapterSlug
      finishedChapterRef.current = latchChapterEnd(finishedChapterRef.current, data.progress)
      const bp = updateBookProgress(chapterSlug || null, data.progress)
      // The reading session wants BOOK progress. `ReadingSession.EndPercent >= 0.99`
      // is how the server decides a book was finished, so a chapter fraction here —
      // which is 1.0 at the end of every chapter — minted a book-completion per
      // chapter. Until the chapter list lands there is no book progress, and the
      // session is only told the reader is active.
      // A programmatic restore in flight is travel; the report after it lands is a jump whose
      // distance is not reading (newer position elsewhere, rebuild, reflow). The WebView reports
      // every landing right after its ack, so this is always the landing, never the next scroll.
      const jump = sessionJumpRef.current
      if (bp != null && sessionSettledRef.current && jump !== 'pending') {
        if (jump === 'landed') sessionJumpRef.current = 'idle'
        updateSessionProgress(bp, { jump: jump === 'landed' })
      } else recordSessionActivity()
      bumpProgress()
    } else if (data.type === 'restored') {
      // A restore we injected has actually been applied. Until this arrives the newest position
      // we hold is the load event's zero, and writing it wipes the reader's place — so this
      // message, not the injection, is what opens the write gate.
      sessionSettledRef.current = true
      onRestoreLanded(data.restoreId, data.scrollY)
    } else return false
    return true
  }, [chapters, chapterSlug, updateSessionProgress, onRestoreLanded, bumpProgress, recordSessionActivity])

  return { progress, bookProgress, updateBookProgress, onMessage }
}
