import type { MergeMap } from '@textstack/shared'
import { rekeyUserBookProgress } from './progressStorage'
import { rekeyPendingSessions } from './pendingSessions'
import { rekeyDeclinedDownloads } from './declinedDownloads'

/**
 * PDD "Guest → account merge", mobile's twin of web's `lib/v2Merge.ts`: before the first V2 pull
 * under the account, what this device holds under the guest's ids moves to the account's — the
 * reading records and declined downloads (AsyncStorage) and queued sessions. The
 * caller has emptied the in-memory V2 cache. Mobile queues no vocabulary saves or highlights, so
 * `words` has nothing to re-key. ponytail: the highlight cache (`reader.userhighlights.{userId}.{bookId}`)
 * is keyed by the guest's user id too, so it is a cold cache refilled by the first pull. Best
 * effort: a store that fails keeps its old ids.
 */
export async function applyMergeMap(merge: MergeMap): Promise<void> {
  const books = merge.books ?? {}
  await rekeyUserBookProgress(books)
  await rekeyPendingSessions(books).catch(() => {})
  await rekeyDeclinedDownloads(books)
}
