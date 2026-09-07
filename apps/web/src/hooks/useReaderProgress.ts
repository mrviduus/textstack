import { useMemo } from 'react'
import { useReadingProgress } from './useReadingProgress'
import { useRestoreProgress } from './useRestoreProgress'
import { useUserBookProgress } from './useUserBookProgress'
import type { ReaderMode, NormalizedBook } from './useReaderChapter'
import type { Chapter, BookDetail } from '../types/api'
import type { AutoSaveInfo } from '../components/reader/ReaderTocDrawer'

interface Params {
  mode: ReaderMode
  bookSlug: string | undefined
  chapterSlug: string | undefined
  userBookId: string | undefined
  publicBook: BookDetail | null
  publicChapter: Chapter | null
  book: NormalizedBook | null
}

interface EffectiveProgress {
  chapterSlug: string
  locator: string
  /** Serialised TextPosition (ADR-015). Preferred over `locator` on restore. */
  positionJson?: string | null
  percent: number
}

export interface UseReaderProgressResult {
  publicProgress: ReturnType<typeof useReadingProgress>
  userProgress: ReturnType<typeof useUserBookProgress>
  effectiveProgress: EffectiveProgress | null
  effectiveLoading: boolean
  autoSaveInfo: AutoSaveInfo | null
}

export function useReaderProgress({
  mode,
  bookSlug,
  chapterSlug,
  userBookId,
  publicBook,
  publicChapter,
  book,
}: Params): UseReaderProgressResult {
  const publicProgress = useReadingProgress(
    mode === 'public' ? (bookSlug || '') : '',
    mode === 'public' ? (chapterSlug || '') : '',
    { editionId: publicBook?.id, chapterId: publicChapter?.id, chapterSlug },
  )

  const userProgress = useUserBookProgress(mode === 'userbook' ? (userBookId || '') : '')

  // Public-only restore (userbook restore lives inside useUserBookProgress).
  // URL is authoritative — we never auto-navigate away from a typed chapter.
  const { savedProgress, isLoading: progressLoading } = useRestoreProgress(
    mode === 'public' ? publicBook?.id : undefined,
    chapterSlug,
  )

  const effectiveProgress: EffectiveProgress | null = mode === 'public'
    ? (savedProgress as EffectiveProgress | null)
    : userProgress.savedProgress
      ? {
          chapterSlug: userProgress.savedProgress.chapterSlug,
          locator: userProgress.savedProgress.locator || '',
          positionJson: userProgress.savedProgress.positionJson,
          percent: userProgress.savedProgress.percent,
        }
      : null

  const effectiveLoading = mode === 'public' ? progressLoading : userProgress.isLoading

  const autoSaveInfo = useMemo((): AutoSaveInfo | null => {
    if (mode === 'public') {
      if (!publicBook?.id || !publicBook?.chapters) return null
      try {
        const stored = localStorage.getItem(`reading.progress.${publicBook.id}`)
        if (!stored) return null
        const data = JSON.parse(stored) as { chapterSlug: string; locator: string; percent: number }
        if (!data.chapterSlug) return null
        const ch = publicBook.chapters.find(c => c.slug === data.chapterSlug)
        if (!ch) return null
        return {
          chapterSlug: data.chapterSlug,
          chapterTitle: ch.title,
          locator: data.locator,
          percent: data.percent,
        }
      } catch {
        return null
      }
    }
    if (!book?.chapters || !userProgress.savedProgress?.chapterSlug) return null
    const ch = book.chapters.find(c => c.identifier === userProgress.savedProgress?.chapterSlug)
    if (!ch) return null
    return {
      chapterSlug: userProgress.savedProgress.chapterSlug,
      chapterTitle: ch.title,
      locator: userProgress.savedProgress.locator || '',
      percent: userProgress.savedProgress.percent,
    }
  }, [mode, publicBook?.id, publicBook?.chapters, book?.chapters, userProgress.savedProgress])

  return { publicProgress, userProgress, effectiveProgress, effectiveLoading, autoSaveInfo }
}
