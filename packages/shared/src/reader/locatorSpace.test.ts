import { describe, it, expect } from 'vitest'
import { locatorSpace } from './locatorSpace'

/** The strings here are the ones from the incident, on purpose. */
describe('locatorSpace', () => {
  it('recognises a PDF page', () => {
    expect(locatorSpace('page:16')).toBe('page')
    expect(locatorSpace('page:1')).toBe('page')
  })

  it('recognises a chapter scroll offset', () => {
    expect(locatorSpace('scroll:2-the-mom-test:0')).toBe('scroll')
  })

  it('reads a slug containing colons', () => {
    // Slugs come from titles and titles contain punctuation. Splitting on ':'
    // and counting parts would misread this; a prefix test does not.
    expect(locatorSpace('scroll:part-1:chapter-2:subsection:4200')).toBe('scroll')
  })

  it('does not claim a bookmark locator', () => {
    // `chapter:<slug>` is a bookmark, never progress. There is deliberately no
    // 'chapter' space for it to be mistaken into.
    expect(locatorSpace('chapter:1-intro')).toBeNull()
  })

  it('returns null for anything unrecognised', () => {
    expect(locatorSpace('{"type":"end"}')).toBeNull()
    expect(locatorSpace('epubcfi(/6/4!/4/2)')).toBeNull()
    expect(locatorSpace('')).toBeNull()
    expect(locatorSpace(null)).toBeNull()
    expect(locatorSpace(undefined)).toBeNull()
  })
})
