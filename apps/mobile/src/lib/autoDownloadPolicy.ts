/**
 * Which of the reader's own books the app should fetch without being asked,
 * and in what order.
 *
 * The product change behind this: offline stopped being a feature you find and
 * switch on. A reader who uploaded a book to us already decided they want it;
 * making them walk into the book and press Download is asking twice.
 *
 * Nothing imported, so the judgement can have a test. The mechanics — network
 * type, budget, the download queue itself — live in the hook that calls this.
 */

/** The fields of a library row this decision actually reads. */
export interface AutoDownloadCandidate {
  id: string
  /** Server-side processing state. Only a finished book has chapters to fetch. */
  status: string
  /** ISO timestamp of the last progress write, or null if never opened. */
  progressUpdatedAt: string | null
  /** ISO timestamp of the upload. */
  createdAt: string
}

const time = (iso: string | null): number => {
  if (!iso) return 0
  const t = Date.parse(iso)
  return Number.isNaN(t) ? 0 : t
}

/**
 * The books to fetch, most deserving first.
 *
 * **Order is last-read, then newest.** A reader coming back to a new phone
 * wants the book they were in the middle of, not the one they uploaded first;
 * and among books never opened, the newest upload is the one they were most
 * recently thinking about. Ordering by upload date alone would start a
 * twenty-book library with the one abandoned two years ago.
 *
 * **Only `Ready` books.** Anything still processing has no chapters to fetch,
 * and a book that failed has none coming.
 *
 * Deliberately NOT here: the storage budget. The caller re-measures between
 * books and stops when it is reached, because sizes are not in the list payload
 * and a total computed up front would be a guess. The rule that matters is in
 * the caller too and is worth stating twice: **an automatic download never
 * evicts anything.** Filling the cache by itself must not delete a book the
 * reader chose to keep — it stops at the budget instead.
 */
export function chooseAutoDownloads(
  books: readonly AutoDownloadCandidate[],
  alreadyCached: ReadonlySet<string>,
): string[] {
  return books
    .filter(b => b.status === 'Ready' && !alreadyCached.has(b.id))
    .slice()
    .sort((a, b) => {
      const byRead = time(b.progressUpdatedAt) - time(a.progressUpdatedAt)
      if (byRead !== 0) return byRead
      return time(b.createdAt) - time(a.createdAt)
    })
    .map(b => b.id)
}

/**
 * May the automatic queue run at all right now?
 *
 * Wi-Fi only, and that is a product decision rather than a technical one: a
 * library of 80 MB uploads arriving over a metered connection is a bill the
 * reader did not agree to. Manual download stays available on any network — it
 * asks first, which is the difference.
 *
 * `null` for the connection type means NetInfo has not answered yet. Treated as
 * "not now": the queue runs on every relevant change, so waiting one event
 * costs nothing, while guessing wrong costs somebody money.
 */
export function mayAutoDownload(input: {
  connectionType: string | null
  hasSession: boolean
  usedBytes: number
  budgetBytes: number
}): boolean {
  if (!input.hasSession) return false
  if (input.connectionType !== 'wifi') return false
  return input.usedBytes < input.budgetBytes
}
