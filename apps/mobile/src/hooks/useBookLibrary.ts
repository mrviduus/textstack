import { useEffect, useRef, useState } from 'react'
import { Alert } from 'react-native'
import { ApiError, collectionsApi, libraryApi } from '@textstack/shared'
import { countCollectionsHolding, decideLibraryRemoval } from '../lib/libraryRemoval'
import { invalidateCollectionsCache } from './useCollections'

/**
 * Book detail's Library membership (LIB-1): is the book saved, and the Save toggle / Download save.
 *
 * One queue: every getLibrary / POST / DELETE starts after the one before it settles, in tap order, so
 * no request overtakes an earlier one (add → remove and remove → add). Writes are optimistic; a
 * getLibrary answering while a write is queued predates that write and is dropped.
 */
export function useBookLibrary(bookId: string | undefined, t: (key: string) => string) {
  const [inLibrary, setInLibrary] = useState(false)
  // Read after an await (the Download's session mint, a queued op): the render's value may be stale by then (LIB-1).
  const inLibraryRef = useRef(false)
  // The book on screen; undefined once unmounted. An answer for any other book is dropped.
  const currentRef = useRef(bookId)
  const queueRef = useRef<Promise<unknown>>(Promise.resolve())
  const writesRef = useRef(0)
  const togglingRef = useRef(false)

  useEffect(() => {
    currentRef.current = bookId
    inLibraryRef.current = false
    setInLibrary(false)
    return () => { currentRef.current = undefined }
  }, [bookId])

  const setSaved = (id: string, saved: boolean) => {
    if (currentRef.current !== id) return
    inLibraryRef.current = saved
    setInLibrary(saved)
  }
  const enqueue = (op: () => Promise<void>) => {
    const p = queueRef.current.then(op)
    queueRef.current = p.catch(() => {})
    return p
  }

  const loadLibrary = async (isCancelled = () => false) => {
    const id = bookId
    if (!id) return
    return enqueue(async () => {
      try {
        const lib = await libraryApi.getLibrary()
        if (!isCancelled() && writesRef.current === 0) setSaved(id, lib.some(item => item.editionId === id))
      } catch (err) {
        console.warn('getLibrary failed on book detail:', err)
      }
    })
  }

  const write = (id: string, saved: boolean, request: (id: string) => Promise<void>, onFail: (err: unknown) => void) => {
    setSaved(id, saved)
    writesRef.current++
    return enqueue(async () => {
      // A later tap is already queued: its optimistic value is the newer truth.
      const last = () => writesRef.current === 1
      try {
        await request(id)
        if (last()) setSaved(id, saved)
      } catch (err) {
        if (last()) onFail(err)
      } finally {
        writesRef.current--
      }
    })
  }
  // Save to Library and Download (LIB-1) share this; a failed add re-reads the server.
  const addToLibrary = async () => {
    const id = bookId
    if (!id) return
    return write(id, true, libraryApi.addToLibrary, err => {
      console.warn('library add failed:', err)
      setSaved(id, false)
      void loadLibrary()
    })
  }
  // The server takes it out of its collections too (#706). No shelf cache: the Library tab refetches on focus.
  const removeFromLibrary = async () => {
    const id = bookId
    if (!id) return
    return write(id, false, x => libraryApi.removeFromLibrary(x).then(invalidateCollectionsCache), err => {
      // 404: it is not in the Library, which is what the remove wanted.
      if (err instanceof ApiError && err.status === 404) return invalidateCollectionsCache()
      console.warn('library remove failed:', err)
      setSaved(id, true)
    })
  }
  const removeWithConfirm = async () => {
    // Removing also empties the book out of every collection it is in,
    // so ask first — but only when there is something to lose. No
    // membership-by-book endpoint: one list per non-empty collection.
    // If the lookup fails the removal goes ahead unasked, as it always
    // did (offline, the removal itself fails and rolls back).
    let count = 0
    try {
      const collections = await collectionsApi.listCollections()
      const lists = await Promise.all(collections
        .filter(c => c.count > 0)
        .map(c => collectionsApi.getCollectionBookIds(c.id, 'savedbook')))
      count = countCollectionsHolding(bookId!, lists)
    } catch (err) {
      console.warn('collection membership lookup failed:', err)
    }
    const decision = decideLibraryRemoval(count)
    if (!decision.confirm) return removeFromLibrary()
    Alert.alert(
      t('library.actions.removeFromLibraryConfirmTitle'),
      t(decision.bodyKey).replace('{{count}}', String(decision.count)),
      [
        { text: t('library.actions.cancel'), style: 'cancel' },
        { text: t('library.actions.removeFromLibraryConfirm'), style: 'destructive', onPress: () => { void removeFromLibrary() } },
      ],
    )
  }
  // The Save button. A tap while the last one is still running is the same tap (a double tap adds once).
  const toggle = async () => {
    if (!bookId || togglingRef.current) return
    togglingRef.current = true
    try {
      if (!inLibraryRef.current) return await addToLibrary()
      // The confirm waits for queued ops; if a Download's add failed there is nothing to remove (LIB-1).
      await queueRef.current
      if (inLibraryRef.current) return await removeWithConfirm()
    } finally {
      togglingRef.current = false
    }
  }
  // Download, Retry and Restart (LIB-1): a download is intent; Cancel never takes it back.
  const saveIfNotSaved = () => { if (!inLibraryRef.current) void addToLibrary() }

  return { inLibrary, loadLibrary, toggle, saveIfNotSaved }
}
