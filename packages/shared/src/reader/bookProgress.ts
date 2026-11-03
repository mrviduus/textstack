/**
 * Book-wide reading progress calculation.
 *
 * The WebView/web reader reports per-chapter scroll progress (0..1). That
 * tells the user how far they are through the CURRENT CHAPTER, not the
 * book — so a fresh chapter looks like 0% even on the last chapter of a
 * long book. Footers, ContinueReadingCard, and any progress UI surface
 * need a book-wide percent built from chapter scroll + chapter word counts.
 *
 * Lives in `@textstack/shared` so both mobile and (future) web readers
 * can share the same formula. Pure, no I/O — unit-tested via Vitest.
 *
 * Strategy:
 *   bookPct = (Σ wordCount of chapters BEFORE current + currentChapter.wordCount * chapterProgress) / totalWordCount
 *
 * Fallback when chapters lack wordCount (extractor didn't measure them
 * — happens for some legacy user uploads):
 *   bookPct = (chapterIndex + chapterProgress) / totalChapters
 *
 * Returns `null` in degenerate cases (no chapters, unknown slug, denom=0)
 * — callers should render a placeholder like '—' rather than a misleading
 * 0%.
 */

/**
 * The stored book-wide percentage — the ONE way to read a book's progress
 * outside the reader.
 *
 * `computeBookProgress` above exists to PRODUCE this number, from a chapter slug
 * and a scroll fraction, inside the reader that has both. Once written it is
 * canonical (that is what the percentUnit contract is for), and anything else
 * that wants it should read it, not derive it again.
 *
 * The book detail screen derived it, and got two things wrong at once. It passed
 * `savedProgress.percent` — already a BOOK fraction — into `computeBookProgress`
 * as the `chapterProgress` argument, which is a CHAPTER fraction, re-scaling an
 * already-scaled number; wrong for every EPUB, just plausibly wrong. And it
 * derived only when a chapter slug was present, which a PDF read in Original
 * layout deliberately has none of — so a book the list showed at 14% read 0%
 * there, and the same screen started agreeing only once the locator had been
 * corrupted into chapter space.
 */
export function storedBookPercent(
  progress: { percent?: number | null } | null | undefined,
): number | null {
  const p = progress?.percent
  return typeof p === 'number' && Number.isFinite(p) ? p : null
}

/**
 * How an unknown percentage is rendered.
 *
 * `null` is '—', never '0%'. The docblock above has always said so; the detail
 * screen mapped null to 0 anyway, which claims the reader opened the book and
 * read none of it — a different and wrong statement.
 *
 * `0` really is '0%': a book opened at the top is not a book never opened.
 */
export function formatBookPercent(pct: number | null): string {
  if (pct == null) return '—'
  return `${Math.round(pct * 100)}%`
}

export interface ChapterWithCount {
  slug: string
  wordCount?: number | null
}

export function computeBookProgress(
  chapters: ChapterWithCount[],
  currentChapterSlug: string | null | undefined,
  chapterProgress: number,
  totalWordCount?: number,
): number | null {
  if (!chapters || chapters.length === 0 || !currentChapterSlug) return null
  const idx = chapters.findIndex(c => c.slug === currentChapterSlug)
  if (idx < 0) return null
  // Defend against NaN/Infinity coming from a WebView 0/0 in `scrollTop /
  // (docHeight - windowHeight)` — propagates and breaks downstream
  // arithmetic if not caught.
  const safeProg = typeof chapterProgress === 'number' && Number.isFinite(chapterProgress) ? chapterProgress : 0
  const clampedProg = Math.max(0, Math.min(1, safeProg))

  // Word-count-weighted path — accurate when extractor populated wordCount
  // on every chapter (long chapters contribute more than short ones).
  const hasAnyWordCount = chapters.some(c => typeof c.wordCount === 'number' && (c.wordCount ?? 0) > 0)
  if (hasAnyWordCount) {
    let completedWords = 0
    for (let i = 0; i < idx; i++) {
      const w = chapters[i].wordCount
      if (typeof w === 'number' && w > 0) completedWords += w
    }
    const curWords = (typeof chapters[idx].wordCount === 'number' && (chapters[idx].wordCount ?? 0) > 0)
      ? (chapters[idx].wordCount as number)
      : 0
    // Prefer the explicit totalWordCount caller passed in (book-level
    // canonical, may include chapters we didn't iterate over). Fall back
    // to the sum we just computed so the API stays usable for callers
    // that don't know the canonical total.
    const denom = totalWordCount && totalWordCount > 0
      ? totalWordCount
      : chapters.reduce((s, c) => s + (typeof c.wordCount === 'number' && c.wordCount > 0 ? c.wordCount : 0), 0)
    if (denom <= 0) return null
    const pct = (completedWords + curWords * clampedProg) / denom
    return Math.max(0, Math.min(1, pct))
  }

  // Equal-weight fallback — every chapter counts the same.
  return Math.max(0, Math.min(1, (idx + clampedProg) / chapters.length))
}

/**
 * The chapter at a book fraction, by cumulative word counts: where a reader resumes from a stored
 * place it cannot resolve (a V2 reader's `epub-cfi`, ADR-031). ponytail: proportional on word
 * counts; a chapter without a count weighs the average.
 */
export function chapterAtFraction(items: { chapterKey: string; wordCount: number | null }[], fraction: number): string | null {
  if (items.length === 0) return null
  const known = items.filter((c) => c.wordCount != null)
  const average = known.length ? known.reduce((s, c) => s + c.wordCount!, 0) / known.length : 1
  const weights = items.map((c) => c.wordCount ?? average)
  const target = Math.min(1, Math.max(0, fraction)) * weights.reduce((s, w) => s + w, 0)
  let sum = 0
  for (let i = 0; i < items.length; i++) {
    sum += weights[i]
    if (target < sum) return items[i].chapterKey
  }
  return items[items.length - 1].chapterKey
}
