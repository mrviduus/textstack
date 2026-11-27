import { ApiError } from '@textstack/shared'
import { fetchFileBytes, liveBook, pullBooks } from '../api/sync'
import type { HostBook } from '../components/reader/ReaderHost'

/**
 * The reader's book (#1225, moved from `ReaderPage`): the current file's bytes, fetched per open, and what the
 * reader syncs. Null: the book has no readable file. `liveBook` answers from this session's copy of the library,
 * so a 404 or "no file" is checked against a fresh pull once (the file may have been replaced) before it is final.
 * `onActivity` runs at each step and each chunk (the page's stall timer); `onPercent` never says 100 before the end.
 */
export async function openBook(id: string, o: { signal: AbortSignal; onActivity: () => void; onPercent: (percent: number) => void }): Promise<HostBook | null> {
  /** The library calls take no signal: their wait ends with the abort. */
  const orAbort = <T,>(p: Promise<T>) => Promise.race([p, new Promise<never>((_, reject) => {
    o.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  })])
  const current = async (fresh: boolean): Promise<HostBook | null> => {
    o.onActivity()
    if (fresh) await orAbort(pullBooks())
    const file = (await orAbort(liveBook(id))).currentFile
    if (!file?.hasContent) return null
    o.onActivity()
    const bytes = await fetchFileBytes(id, file.id, (loaded, total) => {
      o.onActivity()
      // Content-Length may be off (a proxy's encoding): never past 99 % before the bytes are all in.
      if (total) o.onPercent(Math.min(99, Math.floor((loaded / total) * 100)))
    }, o.signal)
    // The reader data of this file goes to and comes from the server (#1226).
    const sync = { bookId: id, fileId: file.id, format: file.format, sha256: file.sha256, size: file.byteSize, name: file.originalName, hasToc: file.hasToc }
    return { bytes, name: file.originalName, sync }
  }
  try {
    const book = await current(false)
    if (book) return book
  } catch (e) {
    if (o.signal.aborted || !(e instanceof ApiError && e.status === 404)) throw e
  }
  if (o.signal.aborted) throw new DOMException('aborted', 'AbortError')
  return current(true)
}
