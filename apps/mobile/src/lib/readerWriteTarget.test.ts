import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The reader writes where the READER is, not where the ROUTE says.
 *
 * The mobile reader appends chapters into one document as you scroll, and the
 * URL never leaves the chapter you opened. Everything that answers "which
 * chapter is this?" therefore has two possible answers, and picking the wrong
 * one is the single most expensive mistake in this codebase's history:
 *
 *   #496  resume believed the route-derived slug and opened chapter one
 *   #500  the same rule, applied on one screen out of three
 *   #501  the route id used as a fallback when the reader had already left
 *   ADR-015 slice 1: a rebuilt document restored a chapter-two fraction into
 *          chapter one, and the debounced save made it permanent
 *
 * `docs/…/ADR-015` evaluated making the ROUTE follow the reader so the question
 * could only have one answer, and declined: by the time the position became a
 * text anchor the data-loss case was gone, and what remained was cosmetic
 * against surgery on the reset key of `useReaderPersistence` and the identity of
 * the WebView document — the two places every one of those four defects lived.
 *
 * This is what was bought instead. It pins, at the source level, that the write
 * path reads the visible chapter and the restore path reads the document's own —
 * the property slice 5 would have made structural. If one of these assertions
 * starts failing, the reasoning in ADR-015 no longer holds and the route
 * genuinely does need to follow the reader.
 */

const read = (p: string) => readFileSync(join(__dirname, p), 'utf8')

describe('the write follows the reader', () => {
  it('saveProgress names the chapter the WebView reports, not the route', () => {
    const src = read('../hooks/useReaderPersistence.ts')
    // `currentChapterSlugRef` is written from the progress message's own slug,
    // which currentChapterBounds derives from the reading line. The route slug
    // is the fallback for before the first message arrives, and nothing else.
    expect(src).toMatch(/const slug = currentChapterSlugRef\.current \|\| gate\.chapterSlug/)
  })

  it('the position is only saved when it belongs to the chapter being saved', () => {
    // The two refs are written by one message each, and a progress message with
    // no text under the reading line leaves the position at its previous value —
    // which may name the chapter before this one.
    const src = read('../hooks/useReaderPersistence.ts')
    expect(src).toMatch(/positionRef\.current\?\.chapterSlug === slug/)
  })

  it('the server chapter id is resolved from the visible slug', () => {
    // Not from the route. The server has no slug column — it derives one by
    // joining this id — so a route id here makes the row disagree with its own
    // locator, which is #496 exactly.
    const src = read('../components/reader/useEditionReaderSource.ts')
    expect(src).toMatch(/chapterIdForSlug\(chaptersRef\.current, snap\.chapterSlug\)/)
  })
})

describe('the restore follows the document', () => {
  it('loads the saved position for the chapter the document was built from', () => {
    // The opposite rule, and it is not a contradiction: a restore can only land
    // in a chapter this document contains. When the saved position names another
    // one, the route is changed instead — which is the narrow, safe half of
    // "the route follows the reader".
    const src = read('../hooks/useReaderPersistence.ts')
    expect(src).toMatch(/loadPosition\(chapterSlug\)/)
    expect(src).toMatch(/navigateToChapter\?\.\(wasIn\)/)
  })

  it('the write gate is keyed on the document, so a rebuild shuts it', () => {
    const src = read('../hooks/useReaderPersistence.ts')
    expect(src).toMatch(/rebuiltFromSlugRef\.current = currentChapterSlugRef\.current/)
    expect(src).toMatch(/dispatchGate\(\{ type: 'chapterEntered', chapterSlug: chapterSlug \?\? null \}\)/)
  })
})
