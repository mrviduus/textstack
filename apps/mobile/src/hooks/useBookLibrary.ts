import { useRef, useState } from 'react'
import { Alert } from 'react-native'
import { ApiError, collectionsApi, libraryApi } from '@textstack/shared'
import { countCollectionsHolding, decideLibraryRemoval } from '../lib/libraryRemoval'
import { invalidateCollectionsCache } from './useCollections'

// ponytail: fixed double-tap window; make it a platform setting if testers report missed taps.
const DOUBLE_TAP_MS = 400

/**
 * Book detail's Library membership (LIB-1): is the book saved, and the Save toggle / Download save.
 *
 * Writes (POST / DELETE) run one after another in tap order, so none overtakes an earlier one
 * (add → remove and remove → add). A getLibrary waits for the writes queued before it but never holds
 * one up: a GET that hangs must not hold a Save. Its answer is dropped when a write started after it.
 */
export function useBookLibrary(bookId: string | undefined, t: (key: string) => string) {
  // The book known to be saved, by id: another book on this screen never inherits it.
  const [savedId, setSavedId] = useState<string | null>(null)
  // Read after an await (the Download's session mint, a queued write): the render's value may be stale by then (LIB-1).
  const savedIdRef = useRef<string | null>(null)
  const writesRef = useRef<Promise<unknown>>(Promise.resolve())
  const pendingRef = useRef(0)   // writes queued or in flight
  const seqRef = useRef(0)       // bumped by every write
  const lastTapRef = useRef(-Infinity)
  const downloadedRef = useRef(false)

  const inLibrary = bookId != null && savedId === bookId
  const isSaved = () => bookId != null && savedIdRef.current === bookId
  const setSaved = (id: string, saved: boolean) => {
    const next = saved ? id : savedIdRef.current === id ? null : savedIdRef.current
    savedIdRef.current = next
    setSavedId(next)
  }

  const loadLibrary = async (isCancelled = () => false) => {
    const id = bookId
    if (!id) return
    await writesRef.current
    // A write was queued meanwhile: it sets the state (a failed add re-reads), so this answer would be dropped.
    if (pendingRef.current) return
    const seq = seqRef.current
    try {
      const lib = await libraryApi.getLibrary()
      if (!isCancelled() && seq === seqRef.current) setSaved(id, lib.some(item => item.editionId === id))
    } catch (err) {
      console.warn('getLibrary failed on book detail:', err)
    }
  }

  const write = (id: string, saved: boolean, request: (id: string) => Promise<void>, onFail: (err: unknown) => void) => {
    setSaved(id, saved)
    pendingRef.current++
    const seq = ++seqRef.current
    const p = writesRef.current.then(async () => {
      // A later tap is already queued: its optimistic value is the newer truth.
      const last = () => seq === seqRef.current
      try {
        await request(id)
        if (last()) setSaved(id, saved)
      } catch (err) {
        if (last()) onFail(err)
      } finally {
        pendingRef.current--
      }
    })
    writesRef.current = p.catch(() => {})
    return p
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
      if (err instanceof ApiError && err.status === 404) return
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
    // A Download tapped meanwhile is intent: it keeps the book (LIB-1).
    if (downloadedRef.current) return
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
  // The Save button. A double tap is one tap.
  const toggle = async () => {
    if (!bookId) return
    const now = Date.now()
    if (now - lastTapRef.current < DOUBLE_TAP_MS) return
    lastTapRef.current = now
    if (!isSaved()) return addToLibrary()
    downloadedRef.current = false
    // The confirm waits for queued writes; if a Download's add failed there is nothing to remove (LIB-1).
    await writesRef.current
    if (isSaved()) return removeWithConfirm()
  }
  // Download, Retry and Restart (LIB-1): a download is intent; Cancel never takes it back.
  const saveIfNotSaved = () => {
    downloadedRef.current = true
    if (!isSaved()) void addToLibrary()
  }

  return { inLibrary, loadLibrary, toggle, saveIfNotSaved }
}
