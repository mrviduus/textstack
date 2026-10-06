import type { PublicHighlight } from '@textstack/shared'

/** Matches highlights against the current chapter regardless of edition vs
 *  user-book mode — the backend stores them on different FK columns
 *  (chapterId / userChapterId).
 *
 *  The reflow WebView has no chapter gate of its own: this is the only thing
 *  keeping another chapter's highlight off the page. It reads the ROW, never
 *  the anchor — an `anchor.chapterId` alone does not match. A PDF highlight is
 *  saved chapterless (no userChapterId), so it never matches a reflow chapter. */
export function matchesChapter(h: Pick<PublicHighlight, 'chapterId' | 'userChapterId'>, chapterId: string): boolean {
  return h.chapterId === chapterId || h.userChapterId === chapterId
}
