import { useCallback } from 'react'
import { Alert } from 'react-native'
import {
  libraryApi, readingProgressApi, userBooksApi, createBooksApi,
  type UserLibraryItem, type UserBookDto, type ReadingProgressDto,
  FINISHED_THRESHOLD,
} from '@textstack/shared'
import { useLanguage } from '../context/LanguageContext'
import { useToast } from '../context/ToastContext'

interface SavedCtx {
  progressMap: Record<string, ReadingProgressDto>
  setLibrary: React.Dispatch<React.SetStateAction<UserLibraryItem[]>>
  setProgressMap: React.Dispatch<React.SetStateAction<Record<string, ReadingProgressDto>>>
  library: UserLibraryItem[]
  onAddToCollection?: () => void
}

interface UploadCtx {
  onChange: () => void
  openDetails: (id: string) => void
  onAddToCollection?: () => void
}

export function useBookActions() {
  const { language, t } = useLanguage()
  const { show: showToast } = useToast()

  const showSavedActions = useCallback((item: UserLibraryItem, ctx: SavedCtx) => {
    const progress = ctx.progressMap[item.editionId]
    // The recorded answer, not a threshold guess. `percent === 1` was one of four
    // different rules across the codebase for "is this finished?"; the fallback
    // covers rows written before editions had a completion field.
    const isFinished = progress?.completedAt != null || (progress?.percent ?? 0) >= FINISHED_THRESHOLD
    const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = []

    buttons.push({
      text: isFinished ? t('library.actions.markUnfinished') : t('library.actions.markFinished'),
      onPress: async () => {
        try {
          const api = createBooksApi(language)
          const book = await api.getBook(item.slug)
          if (book.chapters.length === 0) return
          const ch = isFinished ? book.chapters[0] : book.chapters[book.chapters.length - 1]
          // Not updateProgress: "finished" is not a position, and sending one as `scroll:<slug>:0`
          // reopened the book at the top of its last chapter — where web, doing the same thing from
          // the same menu, wrote a sentinel instead.
          await readingProgressApi.markProgressFinished(item.editionId, {
            chapterId: ch.id,
            finished: !isFinished,
          })
          ctx.setProgressMap(prev => ({
            ...prev,
            [item.editionId]: {
              ...prev[item.editionId],
              editionId: item.editionId,
              percent: isFinished ? 0 : 1,
              completedAt: isFinished ? null : new Date().toISOString(),
              chapterSlug: ch.slug,
              updatedAt: new Date().toISOString(),
            },
          }))
        } catch (e) {
          console.warn('Toggle finished failed:', e)
          showToast({ message: 'Could not update progress. Try again.', variant: 'error' })
        }
      },
    })

    if (ctx.onAddToCollection) {
      buttons.push({
        text: t('library.actions.addToCollection'),
        onPress: ctx.onAddToCollection,
      })
    }

    buttons.push({
      text: t('library.actions.removeFromLibrary'),
      style: 'destructive',
      onPress: async () => {
        const snapshot = ctx.library
        ctx.setLibrary(prev => prev.filter(l => l.editionId !== item.editionId))
        // Drop the shelves cache so Continue reading / Recently added don't
        // keep showing the removed book on the next focus (TTL is 60s).
        try {
          await libraryApi.removeFromLibrary(item.editionId)
        } catch (e) {
          console.warn('Remove from library failed:', e)
          ctx.setLibrary(snapshot)
          showToast({ message: 'Could not remove book. Try again.', variant: 'error' })
        }
      },
    })

    buttons.push({ text: t('library.actions.cancel'), style: 'cancel' })
    Alert.alert(item.title, undefined, buttons)
  }, [language, t, showToast])

  const showUploadActions = useCallback((item: UserBookDto, ctx: UploadCtx) => {
    const s = item.status.toLowerCase()
    const isReady = s === 'ready' || s === 'completed'
    const isFailed = s === 'failed'
    const isProcessing = !isReady && !isFailed
    const isFinished = !!item.completedAt

    const run = async (fn: () => Promise<unknown>, label: string) => {
      try {
        await fn()
        ctx.onChange()
      } catch (e) {
        console.warn(`${label} failed:`, e)
        showToast({ message: `${label} failed. Try again.`, variant: 'error' })
      }
    }

    const buttons: { text: string; style?: 'cancel' | 'destructive'; onPress?: () => void }[] = []

    if (isReady) {
      buttons.push({ text: t('library.actions.viewDetails'), onPress: () => ctx.openDetails(item.id) })
      buttons.push({
        text: isFinished ? t('library.actions.markUnfinished') : t('library.actions.markFinished'),
        onPress: () => run(
          async () => {
            await (isFinished ? userBooksApi.unmarkUserBookComplete(item.id) : userBooksApi.markUserBookComplete(item.id))
            // Completion toggles shelf membership (continueReading ↔
            // finishedThisMonth) — invalidate so the live carousel refetches.
          },
          isFinished ? 'Mark as unfinished' : 'Mark as finished',
        ),
      })
      if (ctx.onAddToCollection) {
        buttons.push({
          text: t('library.actions.addToCollection'),
          onPress: ctx.onAddToCollection,
        })
      }
    }
    if (isFailed) {
      buttons.push({
        text: t('library.actions.retry'),
        onPress: () => run(() => userBooksApi.retryUserBook(item.id), 'Retry'),
      })
    }
    if (isProcessing) {
      buttons.push({
        text: t('library.actions.cancel'),
        style: 'destructive',
        onPress: () => run(async () => {
          await userBooksApi.cancelUserBook(item.id)
          // Cancelling removes the in-progress upload from recentlyAdded /
          // continueReading — invalidate so the live carousel refetches.
        }, 'Cancel upload'),
      })
    }
    buttons.push({
      text: t('library.actions.delete'),
      style: 'destructive',
      onPress: () => {
        Alert.alert(
          t('library.actions.confirmDeleteTitle'),
          t('library.actions.confirmDeleteBody').replace('{title}', item.title || 'Untitled'),
          [
            { text: t('library.actions.confirmDeleteCancel'), style: 'cancel' },
            {
              text: t('library.actions.confirmDeleteConfirm'),
              style: 'destructive',
              onPress: () => run(async () => {
                await userBooksApi.deleteUserBook(item.id)
                // Invalidate shelves so the deleted upload disappears from
                // Continue reading / Recently added immediately.
              }, 'Delete book'),
            },
          ],
        )
      },
    })
    buttons.push({ text: t('library.actions.cancel'), style: 'cancel' })

    Alert.alert(item.title || 'Untitled', undefined, buttons)
  }, [t, showToast])

  return { showSavedActions, showUploadActions }
}
