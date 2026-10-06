import { useCallback, useMemo } from 'react'
import { serverProvablyNewer } from '@textstack/shared'
import { useAuth } from '../context/AuthContext'
import { readProgress } from '../api/auth'
import { readUserBookProgress } from '../api/userBooks'
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
  /** The open restored from this device because the server gave no answer (timeout or failure). */
  serverUnanswered: boolean
  /** Re-ask the server; see {@link NewerPositionResult}. */
  fetchNewerPosition: (signal: AbortSignal) => Promise<NewerPositionResult>
}

/**
 * - a position: the server row is provably newer than this device's record (another device read
 *   on since — `serverProvablyNewer`, on client stamps, skew clamped);
 * - `false`: the server answered and there is nothing newer;
 * - `null`: no answer (auth not settled, timed out, offline, 5xx, 401) — ask again later.
 */
export type NewerPositionResult = { chapterSlug: string; locator: string | null; positionJson: string | null } | false | null

/** This device's record for the book: the restore source and every save land here. */
function localStamp(key: string): { updatedAt: number } | null {
  try {
    const raw = localStorage.getItem(key)
    const updatedAt = raw ? (JSON.parse(raw) as { updatedAt?: unknown }).updatedAt : undefined
    return typeof updatedAt === 'number' ? { updatedAt } : null
  } catch {
    return null
  }
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
  const { savedProgress, isLoading: progressLoading, serverUnanswered: publicServerUnanswered } = useRestoreProgress(
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
  const serverUnanswered = mode === 'public' ? publicServerUnanswered : userProgress.serverUnanswered

  const { isAuthenticated, isLoading: authLoading } = useAuth()
  const editionId = publicBook?.id
  const fetchNewerPosition = useCallback(async (signal: AbortSignal): Promise<NewerPositionResult> => {
    if (authLoading) return null
    if (!isAuthenticated) return false
    const [server, key] = mode === 'public'
      ? [editionId ? await readProgress(editionId, signal) : null, `reading.progress.${editionId}`]
      : [userBookId ? await readUserBookProgress(userBookId, signal) : null, `userbook.progress.${userBookId}`]
    if (server === undefined || signal.aborted) return null
    if (!server?.chapterSlug || !serverProvablyNewer(localStamp(key), server)) return false
    return { chapterSlug: server.chapterSlug, locator: server.locator ?? null, positionJson: server.positionJson ?? null }
  }, [authLoading, isAuthenticated, mode, editionId, userBookId])

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

  return { publicProgress, userProgress, effectiveProgress, effectiveLoading, autoSaveInfo, serverUnanswered, fetchNewerPosition }
}
