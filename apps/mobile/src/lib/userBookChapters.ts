/**
 * The route/cache key for one chapter of an uploaded book.
 *
 * `slug` is nullable on the wire (`UserBookDetailResponse.chapters[].slug`) and
 * the fallback has to match the one the reader route already uses, or a book
 * downloaded for offline is keyed under names the reader never asks for. It was
 * written inline in `useUserBookReaderSource` and had to be written again for
 * the download; a second copy of a key derivation is how a cache misses itself.
 */
export function userBookChapterSlug(chapter: { slug?: string | null; chapterNumber: number }): string {
  const slug = chapter.slug?.trim()
  return slug ? slug : `chapter-${chapter.chapterNumber}`
}
