/**
 * The position the "read further on another device" prompt offered, carried to the chapter it opens.
 *
 * That chapter is another mount (router.replace remounts the reader), and its own open reads the
 * DEVICE record — which still names the chapter just left, stamped newer than anything the server
 * holds. So it opened at the top, and the reader's first scroll overwrote the other device's
 * position (C2). The leaving reader hands the server's answer over here; the arriving one claims it
 * instead of asking again. Same shape as `readerVisit`: module state, one slot, one reader on screen.
 */
export const HANDOFF_MS = 30_000

let slot: { key: string; chapterSlug: string; saved: unknown; at: number } | null = null

export function handOffPosition<T>(key: string, chapterSlug: string, saved: T, now = Date.now()): void {
  slot = { key, chapterSlug, saved, at: now }
}

/** The handed position for this book + chapter, or null. Any claim empties the slot. */
export function claimPosition<T>(key: string, chapterSlug: string, now = Date.now()): T | null {
  const s = slot
  slot = null
  if (!s || s.key !== key || s.chapterSlug !== chapterSlug || now - s.at > HANDOFF_MS) return null
  return s.saved as T
}

/**
 * Where each chapter of the open book was last saved, this app run — so Prev returns to the place
 * a chapter was left. The device record is ONE row per book (progressStorage) and names the last
 * chapter saved, so after Next and a little reading the chapter before had no position anywhere
 * on the phone and reopened at the top. One book at a time; another book's save starts over.
 * ponytail: in memory only — a killed app forgets the chapters behind the record; persist per
 * chapter if that is ever asked for.
 */
let left: { key: string; bySlug: Map<string, unknown> } | null = null

export function rememberChapterPosition<T>(key: string, chapterSlug: string, saved: T): void {
  if (left?.key !== key) left = { key, bySlug: new Map() }
  left.bySlug.set(chapterSlug, saved)
}

export function recallChapterPosition<T>(key: string, chapterSlug: string): T | null {
  return left?.key === key ? (left.bySlug.get(chapterSlug) as T | undefined) ?? null : null
}

/** Sign-out: one account's places are not the next one's. */
export function forgetChapterPositions(): void {
  left = null
}
