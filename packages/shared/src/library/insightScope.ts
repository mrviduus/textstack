/**
 * What an insight is *about*, as a label — the one decision both clients were
 * making separately.
 *
 * Returns `null` for a book-level insight, because the words for that are a
 * translated string ("This book") and this package holds no strings. The caller
 * supplies them; what it must not do is re-derive the rest.
 *
 * Two things are easy to get wrong here, and both were, once:
 *
 * **Never the chapter number.** `chapterNumber` is what the server orders by, but
 * it is not a display ordinal and never was: on production every edition starts
 * at 0 while four uploaded books start at 2, and the two clients compensate
 * differently — a catalog screen renders `chapterNumber + 1`, an upload renders
 * it as-is. Printing it reads one off the table of contents on exactly one of
 * them. The title is what identifies a chapter to a reader anyway.
 *
 * **Fall back to the slug, do not drop the row.** A re-ingest can rename a
 * chapter, and then the slug this insight was keyed on resolves to nothing and
 * the server returns a null title. The conclusion is still worth reading; it just
 * cannot be placed. Showing the raw slug is worse than a title and much better
 * than silence.
 */
export interface InsightScopeInput {
  chapterSlug: string | null
  chapterTitle: string | null
}

export function insightChapterLabel(insight: InsightScopeInput): string | null {
  if (insight.chapterSlug === null) return null
  return insight.chapterTitle ?? insight.chapterSlug
}

/**
 * When the conclusion was last written, as a plain calendar date.
 *
 * <p>The panel is something a reader comes back to after a month — that was the whole ask — and a
 * list of conclusions with no dates cannot answer "is this what I thought then, or what I think
 * now". A re-run replaces the row and moves `updatedAt`, so this is genuinely the age of the
 * *current* text rather than of the conversation that started it.</p>
 *
 * <p>Absolute, not relative. "3 days ago" is the right register for a shelf of things in progress
 * and the wrong one here: the question a конспект answers is *when did I settle this*, and by the
 * time it matters the answer is months, where relative time stops being informative. ISO rather
 * than a locale format because this package holds no locale — the clients render it verbatim, and
 * the value is unambiguous in every one of them.</p>
 *
 * <p>Returns null for a timestamp that does not parse, so a bad row loses its date rather than
 * printing `Invalid Date` next to a conclusion.</p>
 */
export function insightDateLabel(insight: { updatedAt: string }): string | null {
  const at = new Date(insight.updatedAt)
  if (Number.isNaN(at.getTime())) return null
  return at.toISOString().slice(0, 10)
}
