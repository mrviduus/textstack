/**
 * The rules about a stored original, with nothing imported.
 *
 * Split from `originalFileCache.ts` for the same reason `epubFileName.ts` is
 * its own module: the cache pulls in `react-native` and the API client, and the
 * Vitest project only covers pure `src/lib` modules. The two decisions worth a
 * test — where the file lives, and when to ask before spending mobile data —
 * live here where they can have one.
 */

export type OriginalFormat = 'pdf' | 'epub'

/** Directory name under `Paths.document`. Shared with the sign-out wipe. */
export const ORIGINALS_DIR = 'originals'

/** Suffix of a download still in flight. Renamed onto the real name on success,
 *  so a half-written file is never mistaken for a readable book. */
export const PART_SUFFIX = '.part'

/**
 * `<bookId>.<ext>` — the on-disk name for one upload's original.
 *
 * Pure so the reader, the download loop and the sign-out wipe cannot disagree
 * about where the file is. The id is a server GUID and needs no escaping; the
 * check is here so that stops being an assumption if the shape ever changes —
 * a `..` or a slash arriving in an id would otherwise write outside the
 * directory.
 */
export function originalFileName(bookId: string, format: OriginalFormat): string {
  if (!/^[A-Za-z0-9_-]+$/.test(bookId)) {
    throw new Error(`originalFileName: unsafe book id ${JSON.stringify(bookId)}`)
  }
  return `${bookId}.${format}`
}

/** Over this, downloading on a metered connection is worth one question.
 *  Roughly half the 21 MB reference document: below it the prompt costs more
 *  attention than the data costs money. */
export const CELLULAR_WARN_BYTES = 10 * 1024 * 1024

/**
 * Should the reader be asked before spending mobile data on this?
 *
 * The one product rule here. We download over any connection — refusing
 * outright is what infuriates someone deliberately grabbing a book before a
 * flight — but a large file on a metered link is a surprise worth one tap.
 */
export function shouldConfirmOnCellular(sizeBytes: number | null, isCellular: boolean): boolean {
  if (!isCellular) return false
  // Unknown size counts as large: the server did not say, and the guess that
  // costs someone money is the wrong one to make silently.
  if (sizeBytes === null) return true
  return sizeBytes > CELLULAR_WARN_BYTES
}

/** "21.4 MB" — for the download button, which says what it is about to spend. */
export function formatBytes(bytes: number | null): string | null {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return null
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1)} GB`
}

/** How much of the device we are willing to hold, across every stored original.
 *
 *  Two gigabytes, level with the largest real tier (Supporter): a reader whose
 *  whole server-side library fits in their plan also fits on their phone, and
 *  eviction is for the tail rather than the norm. The measured figures it is
 *  set against: an upload is capped at 80 MB by the platform, the reference
 *  document is 21 MB, and a real reader's whole library was 167 MB. */
export const CACHE_BUDGET_BYTES = 2 * 1024 * 1024 * 1024

/** One stored file, as the evictor sees it. `lastUsedAt` is the file's mtime:
 *  Linux is commonly mounted `noatime`, so an access time cannot be trusted and
 *  reads touch the mtime instead — the same trick `EdgeTtsService` uses. */
export interface CacheEntry {
  name: string
  bookId: string
  bytes: number
  lastUsedAt: number
}

/**
 * Which files to delete to get back under budget, oldest first.
 *
 * Kept pure and separate from the filesystem because it is the part with a
 * judgement in it, and the judgement has a sharp edge: **a book being read, or
 * holding progress that has not reached the server, is never evicted.** Losing
 * the file under a reader mid-chapter turns a working book into a download
 * prompt; losing one whose position never synced loses the position with it.
 * Better to sit over budget than to do either — so this can return a set that
 * does not reach the target, and the caller must not treat that as a failure.
 */
export function chooseEvictions(
  entries: CacheEntry[],
  budgetBytes: number,
  protectedBookIds: ReadonlySet<string>,
): CacheEntry[] {
  const total = entries.reduce((sum, e) => sum + e.bytes, 0)
  if (total <= budgetBytes) return []

  const evictable = entries
    .filter(e => !protectedBookIds.has(e.bookId))
    .sort((a, b) => a.lastUsedAt - b.lastUsedAt)

  const chosen: CacheEntry[] = []
  let freed = 0
  for (const entry of evictable) {
    if (total - freed <= budgetBytes) break
    chosen.push(entry)
    freed += entry.bytes
  }
  return chosen
}

/**
 * Is this the device running out of space, rather than a transient failure?
 *
 * It matters because the two deserve opposite treatment and currently get the
 * same one: the download loop retries three times with backoff per chapter, so
 * a full disk on chapter 10 of 120 spends about three minutes failing the other
 * 110 and then advises "Tap Retry", which cannot help. The web side already
 * distinguishes them (`QuotaExceededError` → stop, "Storage full").
 */
export function isOutOfSpaceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '')
  return /SQLITE_FULL|ENOSPC|disk is full|No space left|QuotaExceeded/i.test(message)
}
