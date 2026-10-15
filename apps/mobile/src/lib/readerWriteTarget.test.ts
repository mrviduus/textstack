import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The reader writes where the READER is — and since 2026-10-03 that has only
 * one answer.
 *
 * The mobile reader used to append chapters into one document as you scrolled,
 * while the URL stayed on the chapter you opened, so "which chapter is this?"
 * had two answers and picking the wrong one was the most expensive mistake in
 * this codebase's history:
 *
 *   #496  resume believed the route-derived slug and opened chapter one
 *   #500  the same rule, applied on one screen out of three
 *   #501  the route id used as a fallback when the reader had already left
 *   ADR-015 slice 1: a rebuilt document restored a chapter-two fraction into
 *          chapter one, and the debounced save made it permanent
 *
 * ADR-015 declined making the route follow the reader. The addendum of
 * 2026-10-03 did the other thing: the document holds ONE chapter, the one the
 * route names, and the reader moves on with the end-of-chapter block (as the
 * web reader has since #161). These assertions pin that the two answers cannot
 * come back.
 */

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8')

describe('one chapter per document', () => {
  it('the document holds a single chapter, named once', () => {
    // ADR-015 anchors are scoped to one chapter: the engine page opens one <template>, under one slug.
    const html = read('readerHtml.ts')
    expect(html.match(/<template id="ts-chapter">/g)).toHaveLength(1)
    expect(read('readerEnginePage.ts')).toMatch(/^const href = root\.dataset\.slug \?\? ''$/m)
  })
})

describe('the write follows the reader', () => {
  it('saveProgress names the chapter the WebView reports, falling back to the route', () => {
    const src = read('../hooks/useReaderPersistence.ts')
    expect(src).toMatch(/const slug = currentChapterSlugRef\.current \|\| gate\.chapterSlug/)
  })

  it('the position is only saved when it belongs to the chapter being saved', () => {
    const src = read('../hooks/useReaderPersistence.ts')
    expect(src).toMatch(/positionRef\.current\?\.chapterSlug === slug/)
  })

  it('the server chapter id is resolved from the saved slug', () => {
    // The server has no slug column — it derives one by joining this id — so an
    // id that disagrees with the locator is #496 exactly.
    const src = read('../components/reader/useEditionReaderSource.ts')
    expect(src).toMatch(/chapterIdForSlug\(chaptersRef\.current, snap\.chapterSlug\)/)
  })
})

// The restore follows the document (loadPosition(route chapter); a rebuild shuts the write gate
// until its restore lands): behaviour tests in hooks/useReaderPersistence.test.ts (C1, rule 8).

describe('book progress is never a chapter fraction', () => {
  // A chapter fraction is 1.0 at the end of every chapter; written into the
  // book-wide column it marks the book finished. Hooks do not run in this lane,
  // so the rule is pinned in the source.
  const src = read('../components/reader/useEditionReaderSource.ts')

  it('skips the server write until the book percent is known', () => {
    const guard = src.indexOf('if (snap.bookPercent == null) return')
    expect(guard).toBeGreaterThan(-1)
    expect(src.indexOf('readingProgressApi.updateProgress(')).toBeGreaterThan(guard)
    expect(src).toMatch(/progress: snap\.bookPercent,/)
  })

  it('never falls back to the chapter fraction', () => {
    expect(src).not.toMatch(/bookPercent \?\? snap\.chapterPercent/)
  })

  it('repeats the save once the chapter list lands', () => {
    expect(src).toMatch(/chaptersArrivedRef\.current = true\s*saveProgress\(\)/)
  })
})
