import { useCallback, useEffect, useRef, useState } from 'react'
import type { MutableRefObject } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  decideReaderExitPrompt,
  OWN_BOOK_ASK_SEEN_KEY,
  type ReaderExitPrompt,
} from '../lib/firstRun'

type Router = { back: () => void; replace: (href: string) => void }

type Options = {
  router: Router
  saveProgress: () => void
  /** ms before the words-saved summary auto-dismisses and pops the screen. */
  autoDismissMs?: number
  /** Whose book this is — an upload never gets asked to bring one. */
  sourceKind: 'edition' | 'userbook'
  /** Latched by the caller with `latchChapterEnd` on each progress message.
   *  A ref, not a value: it is only ever read at the instant of leaving. */
  finishedChapterRef: MutableRefObject<boolean>
  /** Words already saved earlier in this visit — the reader remounts on a chapter change
   *  (`readerVisit.ts`), and the count belongs to the visit, not the chapter. */
  initialWordCount?: number
}

/**
 * Owns what the reader sees on the way out.
 *
 * Two outcomes, chosen by `decideReaderExitPrompt` (pure, in `src/lib/firstRun.ts`):
 *
 *  - `review-words` — the long-standing "{N} words saved → Review now / Later"
 *    overlay. Unchanged.
 *  - `own-book` — once per install, at the end of a chapter in which words were
 *    actually saved: ask for a book of their own. The product's thesis is *your
 *    books first*, but that ask has to be earned by showing the mechanic, and
 *    this is the moment it has just been felt.
 *
 * **Why exit and not a chapter-end event.** The end of a chapter already has
 * its own inline block (Next / Discuss — `chapterEnd.ts`), and a modal on top
 * of it would interrupt the reader at the one moment they are choosing what to
 * do next. Leaving is the reader's own full stop, and it is where the summary
 * already lives. So chapter-end is a CONDITION (`finishedChapterRef`) rather
 * than a trigger.
 */
export function useReaderExitSummary({
  router,
  saveProgress,
  autoDismissMs = 5000,
  sourceKind,
  finishedChapterRef,
  initialWordCount = 0,
}: Options) {
  const [sessionWordCount, setSessionWordCount] = useState(initialWordCount)
  const [prompt, setPrompt] = useState<Exclude<ReaderExitPrompt, 'none'> | null>(null)
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Starts `true`: until AsyncStorage answers we behave as though the ask has
  // already been made. Asking twice is worse than asking a beat later, and the
  // read resolves in milliseconds against a session that lasts minutes.
  const [askSeen, setAskSeen] = useState(true)

  useEffect(() => {
    let cancelled = false
    AsyncStorage.getItem(OWN_BOOK_ASK_SEEN_KEY)
      .then(v => { if (!cancelled) setAskSeen(v === '1') })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    return () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
    }
  }, [])

  /** What leaving right now would show. Also read by the Android back handler,
   *  which must not swallow a press unless a prompt is genuinely coming. */
  const pendingPrompt = useCallback((): ReaderExitPrompt => decideReaderExitPrompt({
    sessionWordCount,
    sourceKind,
    finishedChapter: finishedChapterRef.current,
    ownBookAskSeen: askSeen,
  }), [sessionWordCount, sourceKind, finishedChapterRef, askSeen])

  const exit = useCallback(() => {
    saveProgress()
    const next = pendingPrompt()
    if (next === 'none') {
      router.back()
      return
    }
    setPrompt(next)
    if (next === 'own-book') {
      // Marked when SHOWN, not when acted on — the promise is one ask per
      // install whatever the answer is. Local state moves too, so a second exit
      // in this same session cannot re-ask before storage is re-read.
      setAskSeen(true)
      AsyncStorage.setItem(OWN_BOOK_ASK_SEEN_KEY, '1').catch(() => {})
      // Deliberately NO auto-dismiss timer: this card asks a question, and five
      // seconds is not long enough to read one and decide.
      return
    }
    exitTimerRef.current = setTimeout(() => router.back(), autoDismissMs)
  }, [saveProgress, pendingPrompt, router, autoDismissMs])

  const exitToReview = useCallback(() => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
    router.replace('/vocabulary/review')
  }, [router])

  const exitToUpload = useCallback(() => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
    // `/my-books/upload` — the `(tabs)/upload` file is a placeholder that
    // renders null; the real screen is the one the "+" tab pushes to.
    router.replace('/my-books/upload')
  }, [router])

  /** Stop the auto-dismiss — the reader is handing the chapter to their assistant (or connecting
   *  one), and the screen must not pop under the sheet. "Later" still leaves. */
  const holdExit = useCallback(() => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
    exitTimerRef.current = null
  }, [])

  const exitLater = useCallback(() => {
    if (exitTimerRef.current) clearTimeout(exitTimerRef.current)
    router.back()
  }, [router])

  return {
    sessionWordCount,
    setSessionWordCount,
    /** Which overlay is up, if any. `null` means the reader is still reading. */
    prompt,
    pendingPrompt,
    exit,
    exitToReview,
    exitToUpload,
    exitLater,
    holdExit,
  }
}
