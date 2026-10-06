/**
 * Book slug → edition id, for this process (H2).
 *
 * The catalog reader's cache is keyed by edition id, and a mount resolves it from the book fetch
 * or from the downloaded-books list. A book read online but never downloaded is in neither when
 * the signal drops: the end block had prefetched the next chapter into SQLite, the next mount
 * (router.replace remounts) could not find the id to read it by, and the reader was told the
 * chapter "isn't available offline". The mount that knew the id leaves it here.
 * Same shape as `positionHandoff`: module state, no persistence.
 */
const ids = new Map<string, string>()

export function rememberEditionId(bookSlug: string, editionId: string): void {
  ids.set(bookSlug, editionId)
}

export function knownEditionId(bookSlug: string | undefined): string | null {
  return (bookSlug && ids.get(bookSlug)) || null
}
