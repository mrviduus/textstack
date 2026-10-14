import { describe, it, expect } from 'vitest'
import { highlightChapterKey, chapterForHighlight, isChapterKey, vocabChapterId } from './textAnchor'
import type { TextAnchor } from './offlineDb'

// Which chapter a highlight is painted in (ReaderHighlights: isChapterKey(highlightChapterKey(row), id, slug)).
// Resolving the anchor's text is the engine's (resolve.test, every producer's frozen anchor).

// H1: a highlight from another chapter must not paint wherever its text recurs.
describe('isChapterKey', () => {
  it('another chapter\'s highlight is not this chapter\'s (ghost); an orphan (no key) is nobody\'s', () => {
    expect(isChapterKey('ch-2', 'ch-3', '3-iii')).toBe(false)
    expect(isChapterKey(null, 'ch-3', '3-iii')).toBe(false)
    expect(isChapterKey('ch-3', 'ch-3', '3-iii')).toBe(true)
  })

  it('a cache-key id ("editionId:slug") matches the chapter by slug', () => {
    expect(isChapterKey('ed-1:3-iii', 'real-guid', '3-iii')).toBe(true)
    expect(isChapterKey('ed-1:2-ii', 'real-guid', '3-iii')).toBe(false)
  })
})

// Review of #719: mobile anchors carry no chapterId ({prefix,exact,suffix}); the row does.
describe('chapter key from the row', () => {
  const mobileAnchor = { prefix: 'went into ', exact: 'the room', suffix: '.', startOffset: 13, endOffset: 21 } as unknown as TextAnchor

  it('paints a mobile anchor in the chapter its ROW names', () => {
    const key = highlightChapterKey({ anchor: mobileAnchor, chapterId: 'ch-3' })
    expect(isChapterKey(key, 'ch-3', '3-iii')).toBe(true)
    expect(isChapterKey(key, 'ch-2', '2-ii')).toBe(false)
  })

  it('row ids fill in for a missing/empty anchor chapterId; neither = orphan', () => {
    const row = { anchor: mobileAnchor, chapterId: '', userChapterId: 'uc-1' }
    expect(highlightChapterKey(row)).toBe('uc-1')
    expect(highlightChapterKey({ ...row, anchor: { ...mobileAnchor, chapterId: '' }, userChapterId: undefined, chapterId: 'c-9' })).toBe('c-9')
    expect(highlightChapterKey({ anchor: mobileAnchor, chapterId: '' })).toBeNull()
  })

  it('resolves the chapter to jump to from any of the ids', () => {
    const chapters = [{ id: 'g-2', identifier: '2-ii' }, { id: 'g-3', identifier: '3-iii' }]
    expect(chapterForHighlight(chapters, { anchor: mobileAnchor, chapterId: 'g-3' })?.identifier).toBe('3-iii')
    expect(chapterForHighlight(chapters, { anchor: mobileAnchor, chapterId: 'ed:2-ii' })?.identifier).toBe('2-ii')
    expect(chapterForHighlight(chapters, { anchor: mobileAnchor, chapterId: '' })).toBeUndefined()
  })
})

describe('vocabChapterId', () => {
  it('never sends an offline cache key or an upload chapter as the vocabulary chapter id', () => {
    expect(vocabChapterId('3f2b8c1e-0000-4000-8000-000000000001')).toBe('3f2b8c1e-0000-4000-8000-000000000001')
    expect(vocabChapterId('3f2b8c1e-0000-4000-8000-00000000000a:2-ii')).toBeUndefined()
    expect(vocabChapterId('abc', 'user-book-id')).toBeUndefined()
    expect(vocabChapterId('')).toBeUndefined()
  })
})
