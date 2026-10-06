import { useEffect, useState, useRef, useMemo } from 'react'
import type { MutableRefObject } from 'react'
import { t, plural, type Language } from '@textstack/shared'
import type { useRouter } from 'expo-router'
import type { useToast } from '../../context/ToastContext'
import { useOnline } from '../../hooks/useOnline'
import { carryVisit } from '../../lib/readerVisit'
import type { useReadingSession } from '../../hooks/useReadingSession'
import { chapterEndModel, type ChapterEndLabels } from '../../lib/chapterEnd'
import type { ReaderShellProps } from './readerShellTypes'

type Args = Pick<ReaderShellProps,
  | 'chapter' | 'chapters' | 'bookTitle' | 'saveProgress' | 'ensureChapter' | 'isChapterOnDevice'
  | 'onNavigateChapter' | 'chapterNavigatorRef' | 'original' | 'injectJs'
> & {
  visitKey: string
  handOffSession: ReturnType<typeof useReadingSession>['handOff']
  sessionWordCount: number
  sessionWordCountRef: MutableRefObject<number>
  finishedChapterRef: MutableRefObject<boolean>
  /** False once the reader unmounted. */
  aliveRef: MutableRefObject<boolean>
  showToast: ReturnType<typeof useToast>['show']
  language: Language
  footerHeight: number
  discussBrief: (() => string) | null
  discuss: () => void
  handleExitReview: () => void
  router: ReturnType<typeof useRouter>
}

/**
 * Leaving the chapter: every chapter change (with the visit handed over), the offline-aware open
 * behind chevrons / TOC / bookmarks / highlights, and the end-of-chapter block and its actions.
 */
export function useReaderChapterNav({
  chapter, chapters, bookTitle, saveProgress, ensureChapter, isChapterOnDevice,
  onNavigateChapter, chapterNavigatorRef, original, injectJs,
  visitKey, handOffSession, sessionWordCount, sessionWordCountRef, finishedChapterRef, aliveRef,
  showToast, language, footerHeight, discussBrief, discuss, handleExitReview, router,
}: Args) {
  // Every chapter change in the reader goes through here (block, chevrons, TOC, bookmarks,
  // highlights). The route change remounts this screen, so the visit is handed to the next one.
  const navigateChapter = (slug: string) => {
    saveProgress()
    const { snapshot, flush } = handOffSession()
    carryVisit({
      key: visitKey,
      session: snapshot,
      savedWords: Math.max(sessionWordCount, sessionWordCountRef.current),
      finishedChapter: finishedChapterRef.current,
    }, flush)
    onNavigateChapter(slug)
  }
  chapterNavigatorRef.current = navigateChapter
  useEffect(() => () => { chapterNavigatorRef.current = null }, [chapterNavigatorRef])

  // --- End of chapter (inline block, drawn by readerHtml's __tsSetChapterEnd) ---
  const [endState, setEndState] = useState({ busy: false, error: false })
  const lastEndTargetRef = useRef<string | null>(null)
  const openFromBlock = async (slug: string) => {
    lastEndTargetRef.current = slug
    setEndState({ busy: true, error: false })
    try {
      await ensureChapter(slug)
    } catch {
      // Offline and not on the device: say so in the block, with Retry — not a dead-end screen.
      if (aliveRef.current) setEndState({ busy: false, error: true })
      return
    }
    if (aliveRef.current) navigateChapter(slug)
  }
  // Chevrons, TOC, bookmarks, highlights (M9). A tap never waits on a network: online, or with the
  // chapter in SQLite, it navigates at once (the next mount's loader is device-first, then network).
  // Only offline AND not on the device does it stay put, with a toast — navigating there meant an
  // error screen whose "Go back" left the book. `openingRef` makes a double tap navigate once; it is
  // never reset after a navigation, because the route change remounts this screen.
  const online = useOnline()
  const openingRef = useRef(false)
  const openChapter = async (slug: string) => {
    if (openingRef.current) return
    openingRef.current = true
    if (online || await isChapterOnDevice(slug).catch(() => false)) {
      if (aliveRef.current) navigateChapter(slug)
      return
    }
    openingRef.current = false
    if (aliveRef.current) showToast({ variant: 'info', icon: 'cloud-offline-outline', message: t(language, 'reader.chapterEnd.unavailable'), bottomOffset: footerHeight })
  }
  const endLabels = useMemo<ChapterEndLabels>(() => ({
    next: t(language, 'reader.chapterEnd.next'),
    nextUntitled: t(language, 'reader.chapterEnd.nextUntitled'),
    prevUntitled: t(language, 'reader.chapterEnd.prevUntitled'),
    finished: t(language, 'reader.chapterEnd.finished'),
    finishedGeneric: t(language, 'reader.chapterEnd.finishedGeneric'),
    discuss: t(language, 'chapterReview.discussChapter'),
    reviewWords: n => plural(n, 'word', 'words', t(language, 'reader.chapterEnd.reviewWords')),
    library: t(language, 'reader.chapterEnd.library'),
    unavailable: t(language, 'reader.chapterEnd.unavailable'),
    retry: t(language, 'common.retry'),
  }), [language])
  const endModel = useMemo(() => chapterEndModel({
    chapters,
    chapterTitle: chapter.title,
    prev: chapter.prev ?? null,
    next: chapter.next ?? null,
    bookTitle,
    canDiscuss: !!discussBrief,
    savedWords: sessionWordCount,
    error: endState.error,
    busy: endState.busy,
  }, endLabels), [chapters, chapter.title, chapter.prev, chapter.next, bookTitle, discussBrief, sessionWordCount, endState, endLabels])
  const endModelJs = `window.__tsSetChapterEnd && window.__tsSetChapterEnd(${JSON.stringify(endModel)})`
  useEffect(() => { if (!original) injectJs(endModelJs) }, [original, endModelJs, injectJs])
  // Read through a ref by useReaderMessages, whose dependency list would otherwise have to name it all.
  const onChapterEndActionRef = useRef<(action: string) => void>(() => {})
  onChapterEndActionRef.current = (action: string) => {
    if (action === 'visible') {
      // Fetch the next chapter onto the device while they read the block: Next is then instant,
      // and works if the signal drops in between.
      if (chapter.next) void ensureChapter(chapter.next.slug).catch(() => {})
    } else if (action === 'next' && chapter.next) void openFromBlock(chapter.next.slug)
    else if (action === 'prev' && chapter.prev) void openFromBlock(chapter.prev.slug)
    else if (action === 'retry' && lastEndTargetRef.current) void openFromBlock(lastEndTargetRef.current)
    else if (action === 'discuss') discuss()
    else if (action === 'review') { saveProgress(); handleExitReview() }
    else if (action === 'library') { saveProgress(); router.dismissTo('/(tabs)/library') }
  }

  return { openChapter, endModelJs, onChapterEndActionRef }
}
