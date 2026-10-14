import { isPdfAnchor } from '@textstack/shared'
import type { HighlightAnchor } from './offlineDb'

// Which chapter a highlight belongs to. The anchor matching itself (the context ladder, the
// disambiguation, the fuzzy fallback) is the reader engine's (`anchorToLocator` + its resolver).

/** An id written while a chapter came from the offline cache: `${editionId}:${slug}`. Never a server id. */
export function isCacheChapterKey(id: string | null | undefined): boolean {
  return !!id && id.includes(':')
}

/** A highlight's chapter key (`highlightChapterKey`) names this chapter: its id, or a cache key ending in its slug. */
export function isChapterKey(key: string | null, chapterId: string | undefined, slug: string | undefined): boolean {
  if (!key) return false
  if (chapterId === key) return true
  return !!slug && isCacheChapterKey(key) && key.endsWith(`:${slug}`)
}

type HighlightRow = { anchor: HighlightAnchor; chapterId?: string | null; userChapterId?: string | null }

/**
 * The chapter a reflow highlight belongs to. The anchor's own id first; mobile
 * anchors carry none ({prefix, exact, suffix}) and some web rows saved '', so
 * the row's columns fill in (an upload's server row has only userChapterId).
 * Null = orphan: nothing says which chapter, so it is never painted.
 */
export function highlightChapterKey(h: HighlightRow): string | null {
  const own = isPdfAnchor(h.anchor) ? '' : h.anchor.chapterId
  return own || h.chapterId || h.userChapterId || null
}

/** The book chapter a highlight lives in, for a cross-chapter jump. */
export function chapterForHighlight<C extends { id: string; identifier: string }>(
  chapters: C[] | undefined,
  h: HighlightRow,
): C | undefined {
  const key = highlightChapterKey(h)
  if (!key || !chapters) return undefined
  return chapters.find((c) => c.id === key)
    ?? (isCacheChapterKey(key) ? chapters.find((c) => key.endsWith(`:${c.identifier}`)) : undefined)
}

/** The chapter id a vocabulary save may send: none for uploads (the server keys them by book) and
 *  none for an offline cache key, which the server would reject and stall the pending queue. */
export function vocabChapterId(chapterId: string | null | undefined, userBookId?: string | null): string | undefined {
  if (userBookId || !chapterId || isCacheChapterKey(chapterId)) return undefined
  return chapterId
}
