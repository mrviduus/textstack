import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
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
  it('nothing appends a chapter into the reader document', () => {
    const html = read('readerHtml.ts')
    expect(html).not.toMatch(/function appendChapter|requestNextChapter|enableInfiniteScroll/)
    expect(existsSync(join(__dirname, '../hooks/useReaderInfiniteScroll.ts'))).toBe(false)
  })

  it('the document tracks a single chapter element', () => {
    // ADR-015 anchors are scoped to one data-chapter-slug element.
    const html = read('readerHtml.ts')
    expect(html).toMatch(/var tsChapter = null;/)
    expect(html).not.toMatch(/chapterSlugs\.push/)
  })

  it('the shell has no second "visible chapter" to disagree with the route', () => {
    const shell = read('../components/reader/ReaderShell.tsx')
    expect(shell).not.toMatch(/visibleChapterSlug|finishedSlugRef/)
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

describe('the restore follows the document', () => {
  it('loads the saved position for the chapter the document was built from', () => {
    const src = read('../hooks/useReaderPersistence.ts')
    expect(src).toMatch(/loadPosition\(chapterSlug\)/)
  })

  it('a rebuild of the same chapter shuts the write gate until its restore lands', () => {
    // A re-parsed chapter or the OpenDyslexic face still rebuilds the document;
    // its load event reports zero, which must not be written over a real place.
    const src = read('../hooks/useReaderPersistence.ts')
    expect(src).toMatch(/const onDocumentRebuild = useCallback\(\(\) => \{\s*dispatchGate\(\{ type: 'chapterEntered', chapterSlug: chapterSlug \?\? null \}\)/)
  })
})
