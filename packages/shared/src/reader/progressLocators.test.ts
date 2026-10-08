import { describe, it, expect } from 'vitest'
import { PROGRESS_LOCATOR_END, PROGRESS_LOCATOR_START, parseChapterLocator } from './progressLocators'
import { locatorSpace } from './locatorSpace'

describe('progress sentinels', () => {
  it('are valid JSON both clients and the server can round-trip', () => {
    expect(JSON.parse(PROGRESS_LOCATOR_END)).toEqual({ type: 'end' })
    expect(JSON.parse(PROGRESS_LOCATOR_START)).toEqual({ type: 'start' })
  })

  it('belong to no coordinate space', () => {
    // Deliberate, and load-bearing on the server: LocatorSpace.Derive returns null for these, so a
    // sentinel is never mistaken for a page or a scroll offset. It also means a sentinel cannot
    // replace a stored page/scroll position on the guarded (upload) path — which is why uploads
    // mark progress with a scroll locator instead, and only catalog books use these.
    expect(locatorSpace(PROGRESS_LOCATOR_END)).toBeNull()
    expect(locatorSpace(PROGRESS_LOCATOR_START)).toBeNull()
  })
})

describe('parseChapterLocator', () => {
  it('reads the slug of a chapter bookmark locator, including a slug with colons', () => {
    expect(parseChapterLocator('chapter:chapter-two')).toBe('chapter-two')
    expect(parseChapterLocator('chapter:part-1:chapter-2')).toBe('part-1:chapter-2')
  })

  it('anything else is not a chapter locator', () => {
    for (const s of ['chapter:', 'page:7', 'scroll:c:10', '{"type":"end"}', '', 'chapter-two']) {
      expect(parseChapterLocator(s)).toBeNull()
    }
  })
})
