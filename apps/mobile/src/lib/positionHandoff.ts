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
