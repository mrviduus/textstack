import { useCallback } from 'react'
import { useFocusEffect } from 'expo-router'
import type { LibraryEntry } from '@textstack/shared'
import { useToast } from '../context/ToastContext'
import { useDownload } from '../context/DownloadContext'
import type { OfflineState } from '../components/library/OfflineStateBadge'

/** Where each book is, and the tap that changes it — one answer per shelf entry. */
export function useBookOffline() {
  const { show: showToast } = useToast()
  const { onDevice, downloading, download, refreshOnDevice } = useDownload()
  // Back from the reader, which fetches a book it opens: the shelf reads the device again.
  useFocusEffect(useCallback(() => { refreshOnDevice().catch(() => {}) }, [refreshOnDevice]))

  /** The row's own answer, and the tap that changes it. Only uploads are listed (the catalog shelf retired at M6). */
  const offlineFor = (e: LibraryEntry) => {
    const id = e.kind === 'upload' ? e.book.id : e.item.editionId
    const state: OfflineState = downloading.has(id) ? 'downloading' : onDevice.has(id) ? 'on-device' : 'in-cloud'
    // A book with no file on the server has nothing to fetch.
    const downloadable = e.kind === 'upload' && e.book.status.toLowerCase() === 'ready'

    const start = async () => {
      try {
        if (!(await download(id))) showToast({ message: "Couldn't download this book. Try again.", variant: 'error' })
      } catch {
        showToast({ message: "Couldn't download this book. Try again.", variant: 'error' })
      }
    }

    return { state, onDownload: downloadable && state === 'in-cloud' ? start : undefined }
  }

  return offlineFor
}

export type BookOffline = ReturnType<ReturnType<typeof useBookOffline>>
