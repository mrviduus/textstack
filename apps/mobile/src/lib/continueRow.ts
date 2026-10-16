import type { ContinueReadingPick, LibraryEntry } from '@textstack/shared'

export const pickKey = (e: LibraryEntry): string => (e.kind === 'saved' ? `s:${e.item.slug}` : `u:${e.book.id}`)

export const keyOfPick = (p: ContinueReadingPick): string => (p.type === 'userbook' ? `u:${p.id}` : `s:${p.slug}`)

/**
 * The pick a row's Continue acts on, or undefined when the row offers none.
 * `rankContinueReading` already drops 0%, 100% and local-aware finished books, so the pick's own
 * percent is the authority — the progress map can be older than what this phone just recorded.
 * An upload also needs to be ready and not marked finished.
 */
export function continuePickFor(e: LibraryEntry, picks: ReadonlyMap<string, ContinueReadingPick>): ContinueReadingPick | undefined {
  const pick = picks.get(pickKey(e))
  if (!pick) return undefined
  if (e.kind === 'saved') return pick
  const status = e.book.status.toLowerCase()
  const ready = status === 'ready' || status === 'completed'
  return ready && e.book.completedAt == null ? pick : undefined
}

/** The first visible row with a Continue — it gets the filled button, so a filter never leaves the screen with none. */
export function firstContinuePick(entries: readonly LibraryEntry[], picks: ReadonlyMap<string, ContinueReadingPick>): ContinueReadingPick | undefined {
  for (const e of entries) {
    const p = continuePickFor(e, picks)
    if (p) return p
  }
  return undefined
}
