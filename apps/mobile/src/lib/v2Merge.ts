import type { V2MergeMap } from '@textstack/shared'
import { rekeyCachedUserBooks } from './offlineDb'
import { rekeyUserBookProgress } from './progressStorage'
import { rekeyPendingSessions } from './pendingSessions'
import { rekeyDeclinedDownloads } from './declinedDownloads'
import { rekeyDeletedOnServer } from './deletedOnServer'

/**
 * PDD "Guest → account merge", mobile's twin of web's `lib/v2Merge.ts`: before the first V2 pull
 * under the account, what this device holds under the guest's ids moves to the account's — cached
 * chapters and book rows (SQLite), the reading records, declined downloads and server-deleted marks (AsyncStorage) and queued sessions. The
 * caller has emptied the in-memory V2 cache. Mobile queues no vocabulary saves or highlights, so
 * `words` has nothing to re-key. ponytail: a downloaded original keeps its guest-id file name and
 * is fetched again under the new id; the highlight cache (`reader.userhighlights.{userId}.{bookId}`)
 * is keyed by the guest's user id too, so it is a cold cache refilled by the first pull. Best
 * effort: a store that fails keeps its old ids.
 */
export async function applyV2MergeMap(merge: V2MergeMap): Promise<void> {
  const books = merge.books ?? {}
  await rekeyCachedUserBooks(books, merge.files ?? {}).catch(() => {})
  await rekeyUserBookProgress(books)
  await rekeyPendingSessions(books).catch(() => {})
  await rekeyDeclinedDownloads(books)
  await rekeyDeletedOnServer(books)
}
