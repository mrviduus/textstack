import { useCallback } from 'react'
import { Alert } from 'react-native'
import type { UserBookDto } from '@textstack/shared'
import { userBooksApi } from '../lib/userBooksApi'
import { useLanguage } from '../context/LanguageContext'
import { useToast } from '../context/ToastContext'
import { useDownload } from '../context/DownloadContext'
import { deleteBook } from '../lib/reader/deviceDownload'

interface UploadCtx {
  onChange: () => void
  openDetails: (id: string) => void
}

/** A book's menu: details, finish and delete (V2 has no collections, retry or cancel). */
export function useBookActions() {
  const { t } = useLanguage()
  const { show: showToast } = useToast()
  const { refreshOnDevice, syncDevice } = useDownload()

  const showUploadActions = useCallback((item: UserBookDto, ctx: UploadCtx) => {
    const s = item.status.toLowerCase()
    const isReady = s === 'ready' || s === 'completed'
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
              // #1189: off this device at once, offline too; the server's removal goes with the pass.
              onPress: () => run(() => deleteBook(item.id, refreshOnDevice, () => { syncDevice().catch(() => {}) }), 'Delete book'),
            },
          ],
        )
      },
    })
    buttons.push({ text: t('library.actions.cancel'), style: 'cancel' })

    Alert.alert(item.title || 'Untitled', undefined, buttons)
  }, [t, showToast, refreshOnDevice, syncDevice])

  return { showUploadActions }
}
