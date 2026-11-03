import type { MobileAuthResponse } from '@textstack/shared'
import { rekeyCachedUserBooks } from './offlineDb'
import { rekeyUserBookProgress } from './progressStorage'
import { rekeyPendingSessions } from './pendingSessions'
import { forgetV2Session } from './v2'

/**
 * PDD "Guest → account merge", mobile's twin of web's `lib/v2Merge.ts`: before the first V2 pull
 * under the account, what this device holds under the guest's ids moves to the account's — cached
 * chapters and book rows (SQLite), the reading records (AsyncStorage) and queued sessions — and the
 * in-memory V2 cache is emptied. Mobile queues no vocabulary saves or highlights, so `words` has
 * nothing to re-key. ponytail: a downloaded original keeps its guest-id file name and is fetched
 * again under the new id. Best effort: a store that fails keeps its old ids.
 */
export async function applyV2MergeMap(merge: NonNullable<MobileAuthResponse['merge']>): Promise<void> {
  const books = merge.books ?? {}
  forgetV2Session()
  await rekeyCachedUserBooks(books, merge.files ?? {}).catch(() => {})
  await rekeyUserBookProgress(books)
  await rekeyPendingSessions(books).catch(() => {})
}
