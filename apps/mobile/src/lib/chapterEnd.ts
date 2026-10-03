/**
 * The block at the end of a chapter — what it says and which buttons it has.
 * Pure, so the rules are testable; `readerHtml.ts` (`__tsSetChapterEnd`) only
 * draws the model, and taps come back to ReaderShell as `chapterEnd` messages.
 *
 * One chapter per document (2026-10-03, matching web since #161): the next one
 * is never appended — the reader chooses it here.
 */

export interface ChapterEndLabels {
  /** "Next: {title}" */
  next: string
  nextUntitled: string
  prevUntitled: string
  /** "You finished {book}" */
  finished: string
  finishedGeneric: string
  discuss: string
  reviewWords: (n: number) => string
  library: string
  unavailable: string
  retry: string
}

export interface ChapterLink { slug: string; title?: string | null }

export interface ChapterEndInput {
  chapters: { slug: string; title: string }[]
  chapterTitle: string
  prev: ChapterLink | null
  next: ChapterLink | null
  bookTitle: string | null
  /** The chapter can be handed to the reader's assistant (`isReviewableChapter`, book has an id). */
  canDiscuss: boolean
  /** Words saved in this visit. */
  savedWords: number
  /** The last attempt to open the next chapter failed (offline and not on the device). */
  error: boolean
  /** A chapter is being opened — buttons are disabled. */
  busy: boolean
}

export interface ChapterEndModel {
  title: string
  finished: boolean
  next: { slug: string; label: string; counter: string | null } | null
  prev: { slug: string; label: string } | null
  discuss: string | null
  reviewWords: string | null
  library: string | null
  error: string | null
  retry: string
  busy: boolean
}

const fill = (template: string, vars: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`)

export function chapterEndModel(input: ChapterEndInput, labels: ChapterEndLabels): ChapterEndModel {
  const titleOf = (link: ChapterLink) => link.title || input.chapters.find(c => c.slug === link.slug)?.title || ''
  const discuss = input.canDiscuss ? `✦ ${labels.discuss}` : null
  const base = { error: null, retry: labels.retry, busy: input.busy }

  if (!input.next) {
    return {
      ...base,
      title: input.bookTitle ? fill(labels.finished, { book: input.bookTitle }) : labels.finishedGeneric,
      finished: true,
      next: null,
      prev: null,
      discuss,
      reviewWords: input.savedWords > 0 ? labels.reviewWords(input.savedWords) : null,
      library: labels.library,
    }
  }

  const nextTitle = titleOf(input.next)
  const idx = input.chapters.findIndex(c => c.slug === input.next!.slug)
  const prevTitle = input.prev ? titleOf(input.prev) : ''
  return {
    ...base,
    title: input.chapterTitle,
    finished: false,
    next: {
      slug: input.next.slug,
      label: `${nextTitle ? fill(labels.next, { title: nextTitle }) : labels.nextUntitled} ›`,
      counter: idx >= 0 ? `${idx + 1} / ${input.chapters.length}` : null,
    },
    prev: input.prev ? { slug: input.prev.slug, label: `‹ ${prevTitle || labels.prevUntitled}` } : null,
    discuss,
    reviewWords: null,
    library: null,
    error: input.error ? labels.unavailable : null,
  }
}

/**
 * "Discuss this chapter" saves the reading position BEFORE it opens the
 * assistant. The server refuses a review of a chapter beyond the saved progress
 * (`ChapterFrontier`), and at the end of a chapter the debounced save may not
 * have gone out yet — so the assistant would be told "not reached" about the
 * chapter the reader has just finished. A failed save still launches: the
 * server may already hold the position.
 */
export async function discussAfterSave(
  save: () => Promise<unknown> | void,
  launch: () => unknown,
): Promise<void> {
  try { await save() } catch { /* launch anyway */ }
  await launch()
}
