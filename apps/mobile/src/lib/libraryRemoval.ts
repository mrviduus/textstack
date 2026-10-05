/**
 * Removing a catalog book from the library also removes it from every collection it is in
 * (#706, server-side). Collection membership is the reader's own curation, so losing it on one
 * tap of the "In Library" toggle is asked about first — but only when there is something to lose.
 */

/** How many of the given collections' book-id lists contain `bookId`. */
export function countCollectionsHolding(bookId: string, bookIdLists: readonly (readonly string[])[]): number {
  return bookIdLists.filter(ids => ids.includes(bookId)).length
}

export type LibraryRemovalDecision =
  | { confirm: false }
  | {
      confirm: true
      bodyKey: 'library.actions.removeFromLibraryConfirmBodyOne' | 'library.actions.removeFromLibraryConfirmBodyMany'
      count: number
    }

/** In no collection → remove straight away, as before. In one or more → confirm, naming how many. */
export function decideLibraryRemoval(collectionCount: number): LibraryRemovalDecision {
  if (!(collectionCount > 0)) return { confirm: false }
  return {
    confirm: true,
    bodyKey: collectionCount === 1
      ? 'library.actions.removeFromLibraryConfirmBodyOne'
      : 'library.actions.removeFromLibraryConfirmBodyMany',
    count: collectionCount,
  }
}
