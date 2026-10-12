import { useRef, useState } from 'react'
import { Alert } from 'react-native'
import { collectionsApi, libraryApi } from '@textstack/shared'
import { countCollectionsHolding, decideLibraryRemoval } from '../lib/libraryRemoval'
import { invalidateCollectionsCache } from './useCollections'

/** Book detail's Library membership (LIB-1): is the book saved, and the Save toggle / Download save. */
export function useBookLibrary(bookId: string | undefined, t: (key: string) => string) {
  const [inLibrary, setInLibrary] = useState(false)
  // Read after an await (the Download's session mint, an add in flight): the render's value may be stale by then (LIB-1).
  const inLibraryRef = useRef(inLibrary)
  const setSaved = (saved: boolean) => { inLibraryRef.current = saved; setInLibrary(saved) }
  // The Download's add still in flight: a hand remove waits for it, so its DELETE never overtakes the POST (LIB-1).
  const addInFlightRef = useRef<Promise<unknown>>(Promise.resolve())

  // getLibrary, sent only after an add in flight settles, so its answer never predates that POST (LIB-1).
  const loadLibrary = async (isCancelled = () => false) => {
    const editionId = bookId!
    try {
      await addInFlightRef.current
      const lib = await libraryApi.getLibrary()
      if (!isCancelled()) setSaved(lib.some(item => item.editionId === editionId))
    } catch (err) {
      console.warn('getLibrary failed on book detail:', err)
    }
  }
  // Save to Library and Download (LIB-1) share this: optimistic "In Library"; a failed add re-reads the server.
  const addToLibrary = () => {
    setSaved(true)
    const add = libraryApi.addToLibrary(bookId!).then(
      // A getLibrary sent before the POST may answer after it: the write's success is the last word.
      () => setSaved(true),
      err => {
        console.warn('library add failed:', err)
        setSaved(false)
        void loadLibrary()
      },
    )
    addInFlightRef.current = add
    return add
  }
  // Optimistic removal, rolled back if it fails.
  const removeFromLibrary = async () => {
    setSaved(false)
    try {
      await libraryApi.removeFromLibrary(bookId!)
      // The server took it out of its collections too (#706).
      invalidateCollectionsCache()
      // No shelf cache to drop: the Library tab refetches on focus.
    } catch (err) {
      console.warn('library toggle failed:', err)
      setSaved(true)
    }
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
  // The Save button.
  const toggle = async () => {
    if (!inLibrary) return addToLibrary()
    // A remove waits for a Download's add still in flight; if that add failed there is nothing to remove (LIB-1).
    await addInFlightRef.current
    if (inLibraryRef.current) return removeWithConfirm()
  }
  // Download, Retry and Restart (LIB-1): a download is intent; Cancel never takes it back.
  const saveIfNotSaved = () => { if (!inLibraryRef.current) void addToLibrary() }

  return { inLibrary, loadLibrary, toggle, saveIfNotSaved }
}
