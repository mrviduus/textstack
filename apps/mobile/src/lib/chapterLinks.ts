import type { ChapterNav } from '@textstack/shared'

/**
 * A chapter's ‹ › links, with any the chapter lacks taken from the book's ordered chapter list.
 * Upload chapters downloaded before the API's `previous` was mapped (shared toUserBookChapter)
 * sit in SQLite with `prev` null, the reader shows that stored copy first, and the refresh never
 * re-renders it — so ‹ stayed disabled. The list is already loaded for the table of contents.
 */
export function fillChapterLinks<T extends { prev: ChapterNav | null; next: ChapterNav | null }>(
  chapter: T,
  chapters: readonly { slug: string; title: string }[],
  slug: string,
): T {
  if (chapter.prev && chapter.next) return chapter
  const i = chapters.findIndex(c => c.slug === slug)
  if (i < 0) return chapter
  const link = (c: { slug: string; title: string } | undefined) => (c ? { slug: c.slug, title: c.title } : null)
  return { ...chapter, prev: chapter.prev ?? link(chapters[i - 1]), next: chapter.next ?? link(chapters[i + 1]) }
}
