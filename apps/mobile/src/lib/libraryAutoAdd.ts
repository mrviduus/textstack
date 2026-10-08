/**
 * A catalog book joins the library once the reader is 1% in — the same rule as web's
 * `useReaderLibraryTracking`. Mobile had no equivalent, so a book read without tapping "Save to
 * Library" never reached the Library tab, the app's front door. `alreadyAdded` is per open: one
 * POST per reader mount at most, and the server ignores a repeat.
 */
export function shouldAutoAddToLibrary(bookPercent: number | null | undefined, alreadyAdded: boolean): boolean {
  return !alreadyAdded && bookPercent != null && bookPercent >= 0.01
}
