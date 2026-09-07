/**
 * The one chapter we hand a person who has never read here before.
 *
 * Mirrors `apps/web/src/config/demoBook.ts` — same book, same chapter, on
 * purpose. Web has been sending first-time visitors into "Down the Rabbit-Hole"
 * from its hero for a while; a different pick on mobile would mean the two
 * clients teach the product with two different texts and only one of them has
 * ever been watched over a stranger's shoulder.
 *
 * Why this chapter and not chapter one: `1-all-in-the-golden-afternoon` is
 * Carroll's dedicatory poem — verse, archaic, and about nothing. The API lists
 * it as chapterNumber 0. `2-down-the-rabbit-hole` is the first prose chapter,
 * roughly 2,100 words, which is about ten minutes of reading and long enough to
 * meet a dozen words worth long-pressing.
 *
 * Both slugs are verified against production
 * (`GET /api/books/alices-adventures-in-wonderland`). They are content, not
 * code: if the edition is ever re-slugged the card becomes a dead tap with no
 * type error, exactly like any other route literal in this app.
 */
export const DEMO_BOOK = {
  bookSlug: 'alices-adventures-in-wonderland',
  chapterSlug: '2-down-the-rabbit-hole',
  language: 'en',
} as const

/**
 * Deep link into the demo chapter.
 *
 * Note the singular `/reader/{bookSlug}/{chapterSlug}` — the route file is
 * `app/reader/[bookSlug]/[chapterSlug].tsx`, and `src/lib/bookRoutes.ts` builds
 * the same shape for resume. A wrong literal here is not a type error; it lands
 * on `+not-found`.
 */
export function demoBookRoute(): string {
  return `/reader/${DEMO_BOOK.bookSlug}/${DEMO_BOOK.chapterSlug}`
}
