// The seam's `library` on Android. Online it is the web's own calls (`api/userBooks`: the shared client, in bearer
// mode here). The device library stands in when they cannot answer, as in the Expo Library screen: offline, or
// with no session, the books whose file is on this device (#1532, #1608). Delete is device-first (#1189).
import { capabilitiesFor, isOfflineError } from '@textstack/shared'
import * as web from '../../api/userBooks'
import type { UserBook, UserBookDetail, UserBookProgress } from '../../api/userBooks'
import type { Platform } from '../index'
import { storedUser } from './account'
import { getAccessToken } from './api'
import { cachedUserBookDetail, deviceUserBooks } from './cachedUserBookDetail'
import { deleteBook } from './deviceDownload'
import { deviceLocalLibrary, deviceRemovals, signedOutMayList } from './deviceLibrary'
import { syncLibrary, type SyncResult } from './librarySync'
import { uuid } from './native'

/**
 * One library sync pass for the stored session ('off' with none). Opportunistic: nothing on the reading path waits
 * for it. A mounted reader joins with its host (`holdReaderHost`).
 */
export async function syncNow(): Promise<SyncResult> {
  const user = await storedUser()
  if (!user) return 'off'
  return syncLibrary(deviceLocalLibrary(), { userId: user.id, guest: capabilitiesFor(user).isGuest, newId: uuid.v4, reader: () => null })
}

const hasSession = async () => !!(await getAccessToken().catch(() => null))

/** The Library rows of the books on this device (the Expo `cachedUserBook`, with the web row's extra fields). */
async function deviceShelf(): Promise<UserBook[]> {
  const [books, removed] = await Promise.all([deviceUserBooks(deviceLocalLibrary()), deviceRemovals()])
  return books.filter((b) => !removed.has(b.id)).map((b): UserBook => ({ ...b, title: b.title ?? '', status: 'Ready', slug: '', description: null }))
}

/** `work`, or the device's answer when the server cannot give one (offline). Any other failure is the caller's. */
async function orDevice<T>(work: () => Promise<T>, device: () => Promise<T>): Promise<T> {
  if (!(await hasSession())) return device()
  try {
    return await work()
  } catch (e) {
    if (isOfflineError(e)) return device()
    throw e
  }
}

export const library: Platform['library'] = {
  async getUserBooks() {
    return orDevice(
      async () => {
        // #1189: a book deleted here whose removal the server has not taken yet stays hidden.
        const [books, removed] = await Promise.all([web.getUserBooks(), deviceRemovals().catch(() => new Set<string>())])
        return books.filter((b) => !removed.has(b.id))
      },
      // Signed out: the device's books only while no sign-out wipe is owed (#1608).
      async () => ((await hasSession()) || (await signedOutMayList()) ? deviceShelf() : []),
    )
  },
  async getUserBook(id) {
    return orDevice(() => web.getUserBook(id), async () => {
      const b = (await deviceLocalLibrary().books()).find((x) => x.id === id && x.local)
      if (!b) throw Object.assign(new Error('Book not found'), { status: 404 })
      return { ...cachedUserBookDetail(b), toc: null, status: 'Ready' } as UserBookDetail
    })
  },
  async getUserBookProgress(id) {
    return orDevice(() => web.getUserBookProgress(id), async (): Promise<UserBookProgress | null> => {
      const place = (await deviceLocalLibrary().progress()).get(id)
      return place ? { chapterSlug: null, locator: null, percent: place.fraction, updatedAt: place.at ? new Date(place.at).toISOString() : null, positionJson: null, clientUpdatedAt: null } : null
    })
  },
  getUserTags: () => orDevice(() => web.getUserTags(), async () => []),
  uploadUserBook: (file, onProgress) => web.uploadUserBook(file, onProgress),
  // Off this device too (rows, queued writes, the retained file), offline and with no account; the pass pushes the removal.
  deleteUserBook: (id) => deleteBook(id, async () => {}, () => void syncNow().catch(() => {})),
  markUserBookComplete: (id) => web.markUserBookComplete(id),
  unmarkUserBookComplete: (id) => web.unmarkUserBookComplete(id),
  bulkFinishUserBooks: (ids, isFinished) => web.bulkFinishUserBooks(ids, isFinished),
  bulkDeleteUserBooks: (ids) => web.bulkDeleteUserBooks(ids),
  // Runs in render: never throws. ponytail: the server's cover URL; an <img> sends no bearer, so covers need
  // the shell's answer (wave 6, #1643: CORS + auth for images).
  getUserBookCoverUrl: (coverPath) => web.getUserBookCoverUrl(coverPath),
  getUserBookFileUrl: (id) => web.getUserBookFileUrl(id),
}
