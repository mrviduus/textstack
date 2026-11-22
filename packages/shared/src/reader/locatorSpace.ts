/**
 * The coordinate space a reading position is written in.
 *
 * An uploaded book has two readers and they do not share coordinates: the reflow
 * reader stores `scroll:<chapterSlug>:<offset>`, the Original-layout PDF viewer
 * stores `page:<n>`. Both wrote to one column, and the reflow path's close-flush
 * replaced a PDF reader's `page:16` with `scroll:2-the-mom-test:0` — 14% down to
 * 4%, the book reopening ten pages early.
 *
 * The client sends this alongside the locator so the server can tell a deliberate
 * move between spaces from a stale writer clobbering the other one's position.
 * The declaration is not the locator's shape — that is derivable, and a field
 * restating it would say nothing. It means "this write came from a client that
 * knows spaces exist", which is not derivable and is the only thing missing.
 *
 * Mirrored in C# by `LocatorSpace.Derive` in
 * `backend/src/Application/Reading/LocatorSpace.cs`. Change one, change
 * both — the two are a contract, and the tests on each side quote the same
 * locator strings on purpose.
 */

export type LocatorSpaceKind = 'page' | 'scroll'

/** A 1-based page in the original PDF. */
export const LOCATOR_SPACE_PAGE: LocatorSpaceKind = 'page'
/** A scroll offset within a chapter. */
export const LOCATOR_SPACE_SCROLL: LocatorSpaceKind = 'scroll'

/**
 * The space a locator is written in, or null if it is neither.
 *
 * Deliberately no `chapter` value: `chapter:<slug>` is a BOOKMARK locator and is
 * never written as progress. A value for a space nothing writes is how a taxonomy
 * begins to rot.
 */
export function locatorSpace(locator: string | null | undefined): LocatorSpaceKind | null {
  if (!locator) return null
  const s = locator.trim()
  if (s.startsWith('page:')) return LOCATOR_SPACE_PAGE
  if (s.startsWith('scroll:')) return LOCATOR_SPACE_SCROLL
  return null
}
