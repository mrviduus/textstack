import { useEffect, useState } from 'react'
import { userBooksApi, createBooksApi, type LibraryEntry } from '@textstack/shared'
import { useToast } from '../context/ToastContext'
import { useDownload } from '../context/DownloadContext'
import { downloadPercent, offlineStateFor } from '../lib/offlineState'
import { listStoredOriginalIds } from '../lib/originalFileCache'

/** Where each book is, and the tap that changes it — one answer per shelf entry. */
export function useBookOffline() {
  const { show: showToast } = useToast()
  // Where each book actually is. The library downloads itself now, and until
  // this arrived nothing on the shelf admitted it — the reader could not tell
  // what was on the phone from what still needed a connection.
  const { downloads, cachedBooks, cachedUserBooks, startDownload, startUserBookDownload } = useDownload()

  // Which uploads have their original file here. One directory listing for the
  // whole shelf, refreshed when the cache set changes — asking per row would be
  // a filesystem probe per row, and guessing from `isPdf` would be reasoning in
  // a circle: that flag says the book HAS an original, never that we hold it.
  const [storedOriginals, setStoredOriginals] = useState<ReadonlySet<string>>(new Set())
  useEffect(() => {
    let cancelled = false
    listStoredOriginalIds()
      .then(ids => { if (!cancelled) setStoredOriginals(ids) })
      .catch(() => { /* an unreadable directory just means no badge upgrade */ })
    return () => { cancelled = true }
  }, [cachedUserBooks])

  /**
   * The row's own answer, and the tap that changes it — for both halves of the
   * shelf.
   *
   * The two differ in exactly one place: which payload the download needs and
   * where it comes from. Everything else — the state, the percentage, the rule
   * about when a tap is offered — is shared, because a reader looking at a
   * shelf should not be able to tell which half of it they are looking at.
   *
   * The catalogue is fetched on tap rather than held for every row: a list of
   * a hundred editions would otherwise make a hundred detail requests to
   * answer a question only the tapped row asks.
   */
  const offlineFor = (e: LibraryEntry) => {
    const id = e.kind === 'upload' ? e.book.id : e.item.editionId
    const dl = downloads.get(id)
    const meta = e.kind === 'upload'
      ? cachedUserBooks.find(b => b.bookId === id)
      : cachedBooks.find(b => b.editionId === id)
    const isPdfUpload = e.kind === 'upload' && (meta as { isPdf?: boolean } | undefined)?.isPdf === true

    const state = offlineStateFor({
      download: dl ? { status: dl.status, downloadedChapters: dl.downloadedChapters, totalChapters: dl.totalChapters } : null,
      cached: meta ? { cachedChapters: meta.cachedChapters, totalChapters: meta.totalChapters } : null,
      needsOriginal: isPdfUpload,
      hasOriginal: storedOriginals.has(id),
    })

    // A catalogue edition is always downloadable; an upload has to have
    // finished processing first.
    const downloadable = e.kind === 'saved' || e.book.status.toLowerCase() === 'ready'

    const start = async () => {
      try {
        if (e.kind === 'upload') {
          await startUserBookDownload(await userBooksApi.getUserBook(id))
        } else {
          const api = createBooksApi(e.item.language)
          await startDownload(await api.getBook(e.item.slug), e.item.language)
        }
      } catch {
        showToast({ message: "Couldn't start the download. Try again.", variant: 'error' })
      }
    }

    return {
      state,
      percent: dl ? downloadPercent(dl) : null,
      onDownload: downloadable && (state === 'in-cloud' || state === 'partial') ? start : undefined,
    }
  }

  return offlineFor
}

export type BookOffline = ReturnType<ReturnType<typeof useBookOffline>>
