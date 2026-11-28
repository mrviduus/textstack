// The seam's `library` on Android. Online it is the web's own calls (`api/userBooks`: the shared client, in bearer
// mode here). The device library stands in when they cannot answer, as in the Expo Library screen: offline, or
// with no session, the books whose file is on this device (#1532, #1608). Delete is device-first (#1189).
import { ApiError, capabilitiesFor, FileUploadError, isOfflineError } from '@textstack/shared'
import { uploadBook } from '../../api/sync'
import * as web from '../../api/userBooks'
import type { UserBook, UserBookDetail, UserBookProgress } from '../../api/userBooks'
import type { Platform } from '../index'
import { storedUser } from './account'
import { APP_HEADERS, freshAccessToken, getAccessToken, onUnauthorized } from './api'
import { cachedUserBookDetail, deviceUserBooks } from './cachedUserBookDetail'
import { deleteBook, retainBook } from './deviceDownload'
import { deviceLocalLibrary, deviceRemovals, signedOutMayList } from './deviceLibrary'
import { syncLibrary, type SyncResult } from './librarySync'
import { startSyncProbe } from './syncClient'
import { uuid } from './native'

/**
 * One library sync pass for the stored session ('off' with none). Opportunistic: nothing on the reading path waits
 * for it. A mounted reader joins with its host (`holdReaderHost`).
 */
export async function syncNow(retryFailed = false): Promise<SyncResult> {
  const user = await storedUser()
  if (!user) return 'off'
  return syncLibrary(deviceLocalLibrary(), { userId: user.id, guest: capabilitiesFor(user).isGuest, newId: uuid.v4, reader: () => null, retryFailed })
}

/** A pass that only warns: the triggers (a session, the network back, the app shown again) wait for nothing. */
export const syncSoon = (retryFailed = false) => void syncNow(retryFailed).catch((e: unknown) => console.warn('[v2] sync failed:', e))

/**
 * One upload part (web `sendPart`'s contract) with the bearer: the web XHR sends cookies, which this app has not.
 * A 401 refreshes and tries once more; a 413 is the quota, as on the web.
 */
async function sendPart(url: string, part: Blob, onLoaded: (loaded: number) => void): Promise<void> {
  const put = async (token: string | null) => fetch(url, {
    method: 'PUT',
    headers: { ...APP_HEADERS, 'Content-Type': 'application/octet-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: part,
  })
  let res = await put(await freshAccessToken())
  if (res.status === 401) res = await put(await onUnauthorized())
  if (res.status === 413) {
    const body = await res.json().catch(() => null) as { current?: { used: number; limit: number } } | null
    throw new FileUploadError('quota_exceeded', body?.current)
  }
  if (!res.ok) throw new ApiError(res.status, `Upload failed: ${res.status}`)
  onLoaded(part.size)
}

const hasSession = async () => !!(await getAccessToken().catch(() => null))

/** The Library rows of the books on this device (the Expo `cachedUserBook`, with the web row's extra fields). */
async function deviceShelf(): Promise<UserBook[]> {
  const [books, removed] = await Promise.all([deviceUserBooks(deviceLocalLibrary()), deviceRemovals()])
  return books.filter((b) => !removed.has(b.id)).map((b): UserBook => ({ ...b, title: b.title ?? '', status: 'Ready', slug: '', description: null }))
}

/**
 * `work`, or the device's answer: with no session, or when the server cannot give one. `anyError`: every failure but
 * a 404 (a book's page, as the Expo book screen); else offline only (the list: a server error is the caller's).
 */
async function orDevice<T>(work: () => Promise<T>, device: () => Promise<T>, anyError = false): Promise<T> {
  if (!(await hasSession())) return device()
  try {
    return await work()
  } catch (e) {
    if (isOfflineError(e) || (anyError && (e as { status?: number } | null)?.status !== 404)) return device()
    throw e
  }
}

/** #1608: with no session the device's rows are listed only while no sign-out wipe is owed (they are another's then). */
const deviceMayAnswer = async () => (await hasSession()) || (await signedOutMayList())

export const library: Platform['library'] = {
  withoutSession: true,
  async getUserBooks() {
    return orDevice(
      async () => {
        // #1189: a book deleted here whose removal the server has not taken yet stays hidden.
        const [books, removed] = await Promise.all([web.getUserBooks(), deviceRemovals().catch(() => new Set<string>())])
        return books.filter((b) => !removed.has(b.id))
      },
      async () => ((await deviceMayAnswer()) ? deviceShelf() : []),
    )
  },
  async getUserBook(id) {
    return orDevice(() => web.getUserBook(id), async () => {
      const b = (await deviceMayAnswer()) ? (await deviceLocalLibrary().books()).find((x) => x.id === id && x.local) : undefined
      if (!b) throw Object.assign(new Error('Book not found'), { status: 404 })
      return { ...cachedUserBookDetail(b), toc: null, status: 'Ready' } as UserBookDetail
    }, true)
  },
  async getUserBookProgress(id) {
    return orDevice(() => web.getUserBookProgress(id), async (): Promise<UserBookProgress | null> => {
      if (!(await deviceMayAnswer())) return null
      const place = (await deviceLocalLibrary().progress()).get(id)
      return place ? { chapterSlug: null, locator: null, percent: place.fraction, updatedAt: place.at ? new Date(place.at).toISOString() : null, positionJson: null, clientUpdatedAt: null } : null
    }, true)
  },
  getUserTags: () => orDevice(() => web.getUserTags(), async () => []),
  // The web upload sequence with a bearer part sender. Then the book is kept on this device, as a Download does:
  // the reader opens the retained file, and the upload dialog goes straight to the reader.
  // ponytail: the bytes come back from the server; keep the picked file itself if a big book makes that slow.
  async uploadUserBook(file, onProgress) {
    const server = await startSyncProbe()
    if (!server.enabled) throw new ApiError(503, 'Upload failed: the server is unavailable, try again later')
    const result = await uploadBook(file, server.maxPartBytes, sendPart, onProgress)
    // A failure here is not the upload's: the reader's open tries again.
    await retainBook(result.userBookId, () => syncNow()).catch((e: unknown) => console.warn('[v2] upload not kept on the device:', e))
    return result
  },
  // Off this device too (rows, queued writes, the retained file), offline and with no account; the pass pushes the removal.
  deleteUserBook: (id) => deleteBook(id, async () => {}, () => syncSoon()),
  markUserBookComplete: (id) => web.markUserBookComplete(id),
  unmarkUserBookComplete: (id) => web.unmarkUserBookComplete(id),
  bulkFinishUserBooks: (ids, isFinished) => web.bulkFinishUserBooks(ids, isFinished),
  // Device-first as one delete is; one pass pushes every removal. Finish and unfinish stay the server's (as in Expo).
  async bulkDeleteUserBooks(ids) {
    const result: web.BulkResult = { succeeded: [], failed: [] }
    for (const id of ids) {
      await deleteBook(id, async () => {}, () => {}).then(
        () => { result.succeeded.push(id) },
        (e: unknown) => { result.failed.push({ id, reason: (e as Error | null)?.message ?? 'failed' }) },
      )
    }
    syncSoon()
    return result
  },
  // Runs in render: never throws. The server's cover URL; `platform.imageSrc` turns it into an <img> src.
  getUserBookCoverUrl: (coverPath) => web.getUserBookCoverUrl(coverPath),
  getUserBookFileUrl: (id) => web.getUserBookFileUrl(id),
}
