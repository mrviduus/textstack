/**
 * What a library row should say about where a book actually is.
 *
 * The automatic sweep made the library arrive on its own, and that created a
 * new problem: nothing on screen says so. A reader cannot tell what is on the
 * phone, what is coming, and what still needs a connection — which is the one
 * thing Kindle and Play Books both get right and we did not.
 *
 * Nothing imported, so the judgement can have a test. What it deliberately does
 * NOT do is decide where the badge goes or what it looks like.
 */

export type OfflineState =
  /** Readable with no connection. */
  | 'on-device'
  /** Arriving now — by the reader's request or on its own. */
  | 'downloading'
  /** Started and stopped short. Distinct from `in-cloud` because the reader can
   *  finish it, and because saying "in the cloud" about a half-downloaded book
   *  is a lie the next flight would expose. */
  | 'partial'
  /** On the server, and opening it needs a network. */
  | 'in-cloud'

export interface OfflineStateInput {
  /** Live download progress, when one is running for this book. */
  download?: { status: string; downloadedChapters: number; totalChapters: number } | null
  /** What the device's cache metadata says, when there is a row for this book. */
  cached?: { cachedChapters: number; totalChapters: number } | null
  /** PDF uploads need their original file too — chapters alone are the text,
   *  not the book. Undefined for anything that has no original to want. */
  needsOriginal?: boolean
  hasOriginal?: boolean
}

/**
 * The state to show. Order of checks is the whole design:
 *
 * 1. **A running download wins.** It is the most recent truth and the only one
 *    that is about to change.
 * 2. **Then completeness**, which for a PDF upload includes the original file.
 *    A book whose chapters are cached but whose original is missing is not
 *    "on device": offline it opens as text with the figures stripped, which is
 *    exactly the substitution the reader was promised they would stop seeing.
 * 3. **Then partial**, so a stopped download reads as unfinished rather than as
 *    absent — the reader can finish it, and "in the cloud" would be wrong.
 */
export function offlineStateFor(input: OfflineStateInput): OfflineState {
  const dl = input.download
  if (dl && (dl.status === 'downloading' || dl.status === 'queued')) return 'downloading'

  const cached = input.cached
  if (cached && cached.totalChapters > 0 && cached.cachedChapters >= cached.totalChapters) {
    // The original is part of "complete" when the book has one to want.
    if (input.needsOriginal && !input.hasOriginal) return 'partial'
    return 'on-device'
  }

  if ((cached?.cachedChapters ?? 0) > 0) return 'partial'
  // An errored download with nothing cached is still just "not here yet" — the
  // row says where the book is, and the error belongs on the book.
  return 'in-cloud'
}

/** 0-100 for a running download, or null when there is nothing to show. */
export function downloadPercent(
  download: { downloadedChapters: number; totalChapters: number } | null | undefined,
): number | null {
  if (!download || download.totalChapters <= 0) return null
  const pct = Math.round((download.downloadedChapters / download.totalChapters) * 100)
  return Math.max(0, Math.min(100, pct))
}
