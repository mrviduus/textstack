import { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react'
import { AppState, Platform } from 'react-native'
import NetInfo from '@react-native-community/netinfo'
import { uuid } from 'expo-modules-core'
import { userBooksApi } from '../lib/userBooksApi'
import { dropChapterCache, dropOriginalsCache } from '../lib/offlineDb'
import { chooseAutoDownloads, mayAutoDownload } from '../lib/autoDownloadPolicy'
import { offlineStorageBytes } from '../lib/deviceStorage'
import { forgetDeclinedDownloads, listDeclinedDownloads, undeclineDownload } from '../lib/declinedDownloads'
import { booksOnDevice, retainBook } from '../lib/reader/deviceDownload'
import { deviceLocalLibrary } from '../lib/reader/deviceLibrary'
import { syncLibrary } from '../lib/reader/sync'
import { capabilitiesFor } from '../lib/capabilities'
import { CACHE_BUDGET_BYTES } from '../lib/originalFilePolicy'
import { useAuth } from './AuthContext'
import { useReconnectCount } from '../hooks/useOnline'

interface DownloadContextValue {
  /** Books whose file is retained on this device (hostStorage `books/<sha256>`): what "downloaded" means. */
  onDevice: ReadonlySet<string>
  /** Books whose file is being fetched now. */
  downloading: ReadonlySet<string>
  /** The book's file to this device, as opening it would. Resolves to whether it is here now; throws when the fetch failed. */
  download: (bookId: string) => Promise<boolean>
  /** Reads `onDevice` again (the reader may have fetched a book meanwhile). */
  refreshOnDevice: () => Promise<void>
  /** Fetch anything of the reader's own that is not on the device yet. */
  syncOfflineLibrary: () => Promise<void>
  /** One sync pass: the device's library takes what the server holds now (a mark read on the book page, #1552). */
  syncDevice: () => Promise<void>
}

const NONE: ReadonlySet<string> = new Set()

const DownloadContext = createContext<DownloadContextValue>({
  onDevice: NONE,
  downloading: NONE,
  download: async () => false,
  refreshOnDevice: async () => {},
  syncOfflineLibrary: async () => {},
  syncDevice: async () => {},
})

export function useDownload() {
  return useContext(DownloadContext)
}

const without = (set: ReadonlySet<string>, id: string) => {
  const next = new Set(set)
  next.delete(id)
  return next
}

export function DownloadProvider({ children }: { children: ReactNode }) {
  const [onDevice, setOnDevice] = useState<ReadonlySet<string>>(NONE)
  const [downloading, setDownloading] = useState<ReadonlySet<string>>(NONE)
  const { isAuthenticated, user } = useAuth()
  const wasAuthenticatedRef = useRef(isAuthenticated)

  const refreshOnDevice = useCallback(async () => {
    setOnDevice(await booksOnDevice())
  }, [])

  // Once per start: the legacy chapter cache (#1522) and PDF originals cache (#1527) go, then what is on the device is read.
  useEffect(() => {
    dropChapterCache().catch(err => console.warn('[downloads] dropping the chapter cache failed:', err))
    dropOriginalsCache().catch(err => console.warn('[downloads] dropping the originals cache failed:', err))
    refreshOnDevice().catch(err => console.warn('[downloads] reading the device library failed:', err))
  }, [refreshOnDevice])

  // Sign-out (explicit, or a terminal refresh failure): the V2 library and its files are wiped by the
  // sign-out itself (`wipeDeviceLibrary`). Fire-and-forget — a failed wipe must not block the sign-out.
  useEffect(() => {
    if (wasAuthenticatedRef.current && !isAuthenticated) {
      // The declined set names this account's books: gone with it (#1192).
      forgetDeclinedDownloads().catch(() => {})
      setOnDevice(NONE)
      setDownloading(NONE)
    }
    wasAuthenticatedRef.current = isAuthenticated
  }, [isAuthenticated])

  /** A sync pass so the device's library knows the server's books (the reader runs the same on open). */
  const pull = useCallback(async (retryFailed = false) => {
    if (user && Platform.OS !== 'web') await syncLibrary(deviceLocalLibrary(), { userId: user.id, newId: uuid.v4, reader: () => null, guest: capabilitiesFor(user).isGuest, retryFailed })
  }, [user])

  // The app's own pass (#1598): what was saved offline goes on start (a session's first pass retries what had
  // stopped), when the network is back and when the app returns, not only when a reader opens. An open reader
  // takes part in any pass (`holdReaderHost`). The library is Android-only.
  const appPass = useRef(pull)
  appPass.current = pull
  const passNow = (retryFailed = false) => { appPass.current(retryFailed).catch(err => console.warn('[sync] app pass failed:', err)) }
  const reconnects = useReconnectCount()
  useEffect(() => { passNow(true) }, [user?.id])
  useEffect(() => { if (reconnects) passNow() }, [reconnects])
  useEffect(() => {
    const sub = AppState.addEventListener('change', next => { if (next === 'active') passNow() })
    return () => sub.remove()
  }, [])

  /** `pullFirst` for a Download press: the library learns the server's books first. The automatic sweep fetches what it knows. */
  const fetchFile = useCallback(async (bookId: string, pullFirst: boolean) => {
    setDownloading(prev => new Set(prev).add(bookId))
    try {
      const here = await retainBook(bookId, pullFirst ? pull : async () => {})
      if (here) setOnDevice(prev => new Set(prev).add(bookId))
      return here
    } finally {
      setDownloading(prev => without(prev, bookId))
    }
  }, [pull])

  const download = useCallback(async (bookId: string) => {
    // Pressing Download is the reader saying the opposite of an earlier Remove: the sweep may take it again.
    void undeclineDownload(bookId)
    return fetchFile(bookId, true)
  }, [fetchFile])

  /**
   * The library fetches itself: the reader's own books arrive on Wi-Fi without being asked.
   *
   * - **Wi-Fi only.** Manual download still works on any network, because it asks first.
   * - **It never evicts.** The budget stops the queue; it does not make room.
   * - **One at a time**, so a manual download the reader is watching never races a background one.
   */
  const autoRunningRef = useRef(false)
  const autoCancelledRef = useRef(false)
  const autoRerunRef = useRef(false)
  /** Wi-Fi, budget and session, asked fresh before the queue and between books. */
  const autoDownloadAllowed = useCallback(async () => {
    const [net, used] = await Promise.all([NetInfo.fetch(), offlineStorageBytes()])
    return mayAutoDownload({
      connectionType: net.type ?? null,
      hasSession: isAuthenticated,
      usedBytes: used,
      budgetBytes: CACHE_BUDGET_BYTES,
    })
  }, [isAuthenticated])

  const runAutoDownload = useCallback(async (isCancelled: () => boolean, pullFirst = false) => {
    // A sweep already running repeats itself once it finishes rather than dropping this ask.
    if (autoRunningRef.current) {
      autoRerunRef.current = true
      return
    }
    autoRunningRef.current = true
    try {
      do {
        autoRerunRef.current = false
        if (!(await autoDownloadAllowed())) return
        if (pullFirst) await pull()
        // Not paginated: the reader's OWN library, which the server caps at a tier's worth of uploads.
        const [books, here, declined] = await Promise.all([userBooksApi.getUserBooks(), booksOnDevice(), listDeclinedDownloads()])
        const queue = chooseAutoDownloads(books, here, declined)
        if (__DEV__) console.log(`[auto-download] ${queue.length} of ${books.length} book(s) to fetch`)
        for (const id of queue) {
          if (isCancelled()) return
          if (!(await autoDownloadAllowed())) return
          try {
            await fetchFile(id, false)
          } catch (err) {
            // One book failing is not the queue failing; it is retried on the next sweep.
            console.warn(`[auto-download] ${id} skipped:`, err)
          }
        }
      } while (autoRerunRef.current && !isCancelled())
    } finally {
      autoRunningRef.current = false
    }
  }, [autoDownloadAllowed, fetchFile, pull])

  /**
   * Scheduled on the two moments that change the answer — "there is a session now" and "there is Wi-Fi
   * now" — and on coming back to the app. **`runAutoDownload` is deliberately NOT a dependency:** its
   * identity changes with its callbacks, and this effect's cleanup cancels the sweep in flight while the
   * re-entry returns at once (a sweep IS running), so the queue would never reach its first book.
   * Cancellation keys on the session: the sweep stops on unmount or sign-out.
   */
  useEffect(() => {
    if (!isAuthenticated) return
    autoCancelledRef.current = false

    const sweep = () => {
      autoCancelledRef.current = false
      runAutoDownload(() => autoCancelledRef.current)
        .catch(err => console.warn('[auto-download] stopped:', err))
    }
    sweep()

    // The connection TYPE changing is what the gate reads (cellular is already reachable).
    let lastType: string | null = null
    const offNet = NetInfo.addEventListener(state => {
      const type = state.type ?? null
      if (type === lastType) return
      lastType = type
      if (type === 'wifi') sweep()
    })
    const offApp = AppState.addEventListener('change', next => {
      if (next === 'active') sweep()
    })

    return () => {
      autoCancelledRef.current = true
      offNet()
      offApp.remove()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated])

  /** The reader just added a book: the upload screen asks, so it lands on the device too (pulled first). */
  const syncOfflineLibrary = useCallback(async () => {
    if (!isAuthenticated) return
    autoCancelledRef.current = false
    await runAutoDownload(() => autoCancelledRef.current, true)
  }, [isAuthenticated, runAutoDownload])

  return (
    <DownloadContext.Provider
      value={{
        onDevice,
        downloading,
        download,
        refreshOnDevice,
        syncOfflineLibrary,
        syncDevice: pull,
      }}
    >
      {children}
    </DownloadContext.Provider>
  )
}
