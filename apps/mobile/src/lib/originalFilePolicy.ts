/**
 * Rules about a book's file and the device's caches, with nothing imported, so the Vitest project
 * (pure `src/lib` modules) can test them: when to ask before spending mobile data, and which cache
 * entries to evict (the TTS sweep, `deviceStorage.ts`).
 */

/** iOS routes the share sheet by UTI, and without the right one it offers no app that can open the file.
 *  Android uses the MIME type. By the file's format (the six the reader reads). */
const SHARE_TYPES: Record<string, { mimeType: string; uti: string }> = {
  epub: { mimeType: 'application/epub+zip', uti: 'org.idpf.epub-container' },
  pdf: { mimeType: 'application/pdf', uti: 'com.adobe.pdf' },
  mobi: { mimeType: 'application/x-mobipocket-ebook', uti: 'public.data' },
  azw3: { mimeType: 'application/vnd.amazon.mobi8-ebook', uti: 'public.data' },
  fb2: { mimeType: 'application/x-fictionbook+xml', uti: 'public.xml' },
  cbz: { mimeType: 'application/vnd.comicbook+zip', uti: 'public.zip-archive' },
}

/**
 * The extension and types a shared book file goes out with: its real format (#1553), so a MOBI is not
 * named `.epub`. A format not known here (null: neither the device nor the last pull said) shares as an EPUB.
 */
export function shareTypeOf(format: string | null | undefined): { extension: string; mimeType: string; uti: string } {
  const extension = format && SHARE_TYPES[format] ? format : 'epub'
  return { extension, ...SHARE_TYPES[extension] }
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
