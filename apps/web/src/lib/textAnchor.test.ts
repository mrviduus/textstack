import { describe, it, expect, beforeEach } from 'vitest'
import { createTextAnchor, findTextByAnchor, highlightChapterKey, chapterForHighlight } from './textAnchor'
import type { TextAnchor, HighlightAnchor } from './offlineDb'

describe('textAnchor', () => {
  let container: HTMLElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  describe('createTextAnchor', () => {
    it('should create anchor with exact text', () => {
      container.innerHTML = '<p>Hello world, this is a test.</p>'

      const range = document.createRange()
      const textNode = container.querySelector('p')!.firstChild!
      range.setStart(textNode, 6) // Start at "world"
      range.setEnd(textNode, 11)

      const anchor = createTextAnchor(range, 'chapter-1', container)

      expect(anchor.exact).toBe('world')
      expect(anchor.chapterId).toBe('chapter-1')
    })

    it('should include prefix context', () => {
      container.innerHTML = '<p>Hello world, this is a test.</p>'

      const range = document.createRange()
      const textNode = container.querySelector('p')!.firstChild!
      range.setStart(textNode, 6)
      range.setEnd(textNode, 11)

      const anchor = createTextAnchor(range, 'chapter-1', container)

      expect(anchor.prefix).toBe('Hello ')
    })

    it('should include suffix context', () => {
      container.innerHTML = '<p>Hello world, this is a test.</p>'

      const range = document.createRange()
      const textNode = container.querySelector('p')!.firstChild!
      range.setStart(textNode, 6)
      range.setEnd(textNode, 11)

      const anchor = createTextAnchor(range, 'chapter-1', container)

      expect(anchor.suffix).toBe(', this is a test.')
    })

    it('should calculate correct offsets', () => {
      container.innerHTML = '<p>Hello world, this is a test.</p>'

      const range = document.createRange()
      const textNode = container.querySelector('p')!.firstChild!
      range.setStart(textNode, 6)
      range.setEnd(textNode, 11)

      const anchor = createTextAnchor(range, 'chapter-1', container)

      expect(anchor.startOffset).toBe(6)
      expect(anchor.endOffset).toBe(11)
    })

    it('should handle selection across multiple nodes', () => {
      container.innerHTML = '<p>Hello <strong>bold</strong> world</p>'

      const range = document.createRange()
      const helloNode = container.querySelector('p')!.firstChild!
      const worldNode = container.querySelector('p')!.lastChild!
      range.setStart(helloNode, 0)
      range.setEnd(worldNode, 6)

      const anchor = createTextAnchor(range, 'chapter-1', container)

      expect(anchor.exact).toBe('Hello bold world')
    })

    it('should limit prefix to 30 characters', () => {
      container.innerHTML = '<p>This is a very long prefix text that should be truncated. Selected text here.</p>'

      const range = document.createRange()
      const textNode = container.querySelector('p')!.firstChild!
      range.setStart(textNode, 60)
      range.setEnd(textNode, 73)

      const anchor = createTextAnchor(range, 'chapter-1', container)

      expect(anchor.prefix.length).toBeLessThanOrEqual(30)
    })
  })

  describe('findTextByAnchor', () => {
    it('should find text with exact match', () => {
      container.innerHTML = '<p>Hello world, this is a test.</p>'

      const anchor: TextAnchor = {
        prefix: 'Hello ',
        exact: 'world',
        suffix: ', this is a test.',
        startOffset: 6,
        endOffset: 11,
        chapterId: 'chapter-1',
      }

      const range = findTextByAnchor(anchor, container)

      expect(range).not.toBeNull()
      expect(range!.toString()).toBe('world')
    })

    it('should find text using fallback offsets', () => {
      container.innerHTML = '<p>Hello world, this is a test.</p>'

      const anchor: TextAnchor = {
        prefix: 'different prefix', // Wrong prefix
        exact: 'world',
        suffix: 'different suffix', // Wrong suffix
        startOffset: 6,
        endOffset: 11,
        chapterId: 'chapter-1',
      }

      const range = findTextByAnchor(anchor, container)

      expect(range).not.toBeNull()
      expect(range!.toString()).toBe('world')
    })

    it('should return null for non-existent text', () => {
      container.innerHTML = '<p>Hello world, this is a test.</p>'

      const anchor: TextAnchor = {
        prefix: 'prefix',
        exact: 'nonexistent text that is not in the document',
        suffix: 'suffix',
        startOffset: 1000,
        endOffset: 1050,
        chapterId: 'chapter-1',
      }

      const range = findTextByAnchor(anchor, container)

      expect(range).toBeNull()
    })

    it('should find text even when prefix/suffix changed slightly', () => {
      container.innerHTML = '<p>Hello world, this is a test.</p>'

      const anchor: TextAnchor = {
        prefix: 'Hello', // Missing space
        exact: 'world',
        suffix: ', this is',
        startOffset: 6,
        endOffset: 11,
        chapterId: 'chapter-1',
      }

      const range = findTextByAnchor(anchor, container)

      expect(range).not.toBeNull()
      expect(range!.toString()).toBe('world')
    })

    it('should handle empty container', () => {
      container.innerHTML = ''

      const anchor: TextAnchor = {
        prefix: 'prefix',
        exact: 'text',
        suffix: 'suffix',
        startOffset: 0,
        endOffset: 4,
        chapterId: 'chapter-1',
      }

      const range = findTextByAnchor(anchor, container)

      expect(range).toBeNull()
    })

    it('should find first occurrence when multiple matches exist', () => {
      container.innerHTML = '<p>test one test two test three</p>'

      const anchor: TextAnchor = {
        prefix: '',
        exact: 'test',
        suffix: ' one',
        startOffset: 0,
        endOffset: 4,
        chapterId: 'chapter-1',
      }

      const range = findTextByAnchor(anchor, container)

      expect(range).not.toBeNull()
      expect(range!.toString()).toBe('test')
      // Should find the first "test" based on context
    })

    it('returns null for a PDF (kind:pdf) anchor instead of fuzzy-matching exact (M1)', () => {
      // The display text is present in the container, so a naive fuzzy match on
      // `exact` WOULD mis-anchor a chapterless PDF highlight into the reflow DOM.
      // The isPdfAnchor guard must short-circuit to null.
      container.innerHTML = '<p>the quick brown fox jumps</p>'
      const pdfAnchor = {
        v: 1,
        kind: 'pdf',
        page: 2,
        rects: [{ x: 10, y: 20, w: 30, h: 8 }],
        exact: 'quick',
      } as unknown as HighlightAnchor
      expect(findTextByAnchor(pdfAnchor, container)).toBeNull()
    })
  })

  describe('vocab-inline-translation filtering', () => {
    // Legacy VocabWordLayer wraps vocab words in <mark> with a child
    // <span.vocab-inline-translation> holding the translation. Without
    // filtering, that text leaks into anchor prefix/exact/suffix and
    // breaks later lookup.
    it('excludes vocab translation span text from exact', () => {
      container.innerHTML =
        '<p>Hello <mark class="vocab-underline">world<span class="vocab-inline-translation">мир</span></mark> end.</p>'

      const range = document.createRange()
      const p = container.querySelector('p')!
      const helloText = p.firstChild as Text
      const endText = p.lastChild as Text
      range.setStart(helloText, 0)
      range.setEnd(endText, endText.length)

      const anchor = createTextAnchor(range, 'ch-1', container)

      expect(anchor.exact).toBe('Hello world end.')
      expect(anchor.exact).not.toContain('мир')
    })

    it('round-trips through findTextByAnchor with vocab span present', () => {
      container.innerHTML =
        '<p>Hello <mark class="vocab-underline">world<span class="vocab-inline-translation">мир</span></mark> end.</p>'

      const range = document.createRange()
      const mark = container.querySelector('mark')!
      const worldText = mark.firstChild as Text
      range.setStart(worldText, 0)
      range.setEnd(worldText, worldText.length)

      const anchor = createTextAnchor(range, 'ch-1', container)
      const found = findTextByAnchor(anchor, container)

      expect(found).not.toBeNull()
      expect(found!.toString()).toBe('world')
    })
  })

  describe('per-chapter scoping', () => {
    it('matches within correct chapter scope', () => {
      container.innerHTML =
        '<article data-chapter-id="a"><p>The cat sat on the mat.</p></article>' +
        '<article data-chapter-id="b"><p>The dog ran in the park.</p></article>'

      const dogText = container
        .querySelectorAll('article')[1]
        .querySelector('p')!.firstChild as Text

      const range = document.createRange()
      range.setStart(dogText, 4)
      range.setEnd(dogText, 7)

      const anchor = createTextAnchor(range, 'b', container)

      expect(anchor.exact).toBe('dog')
      const found = findTextByAnchor(anchor, container)
      expect(found).not.toBeNull()
      expect(found!.toString()).toBe('dog')
      // Offsets are chapter-relative (4, 7), not document-relative.
      expect(anchor.startOffset).toBe(4)
      expect(anchor.endOffset).toBe(7)
    })

    // H1: a highlight from another chapter must not paint wherever its text recurs.
    it('does not match an anchor from another chapter (ghost)', () => {
      container.innerHTML = '<article data-chapter-id="ch-3"><p>He went into the room.</p></article>'
      const anchor: TextAnchor = {
        prefix: 'She left ', exact: 'the room', suffix: '.', startOffset: 9, endOffset: 17, chapterId: 'ch-2',
      }
      expect(findTextByAnchor(anchor, container)).toBeNull()
    })

    it('does not match an orphan anchor (no chapterId) inside a chapter scope', () => {
      container.innerHTML = '<article data-chapter-id="ch-3"><p>He went into the room.</p></article>'
      const anchor = { prefix: '', exact: 'the room', suffix: '', startOffset: 13, endOffset: 21 } as unknown as TextAnchor
      expect(findTextByAnchor(anchor, container)).toBeNull()
    })

    it('anchors to the chapter wrapper id, not the passed fallback id', () => {
      container.innerHTML = '<article data-chapter-id="real"><p>The dog ran.</p></article>'
      const t = container.querySelector('p')!.firstChild as Text
      const range = document.createRange()
      range.setStart(t, 4)
      range.setEnd(t, 7)
      expect(createTextAnchor(range, 'stale', container).chapterId).toBe('real')
    })
  })

  // Review of #719: mobile anchors carry no chapterId ({prefix,exact,suffix}); the row does.
  describe('chapter key from the row', () => {
    const mobileAnchor = { prefix: 'went into ', exact: 'the room', suffix: '.', startOffset: 13, endOffset: 21 } as unknown as TextAnchor

    it('paints a mobile anchor in the chapter its ROW names', () => {
      container.innerHTML = '<article data-chapter-id="ch-3"><p>He went into the room.</p></article>'
      expect(findTextByAnchor(mobileAnchor, container, 'ch-3')?.toString()).toBe('the room')
      expect(findTextByAnchor(mobileAnchor, container, 'ch-2')).toBeNull()
    })

    it('row ids fill in for a missing/empty anchor chapterId; neither = orphan', () => {
      const row = { anchor: mobileAnchor, chapterId: '', userChapterId: 'uc-1' }
      expect(highlightChapterKey(row)).toBe('uc-1')
      expect(highlightChapterKey({ ...row, anchor: { ...mobileAnchor, chapterId: '' }, userChapterId: undefined, chapterId: 'c-9' })).toBe('c-9')
      expect(highlightChapterKey({ anchor: mobileAnchor, chapterId: '' })).toBeNull()
    })

    it('a cache-key id ("editionId:slug") matches the chapter by slug', () => {
      container.innerHTML = '<article data-chapter-id="real-guid" data-chapter-slug="3-iii"><p>He went into the room.</p></article>'
      expect(findTextByAnchor(mobileAnchor, container, 'ed-1:3-iii')?.toString()).toBe('the room')
      expect(findTextByAnchor(mobileAnchor, container, 'ed-1:2-ii')).toBeNull()
    })

    it('resolves the chapter to jump to from any of the ids', () => {
      const chapters = [{ id: 'g-2', identifier: '2-ii' }, { id: 'g-3', identifier: '3-iii' }]
      expect(chapterForHighlight(chapters, { anchor: mobileAnchor, chapterId: 'g-3' })?.identifier).toBe('3-iii')
      expect(chapterForHighlight(chapters, { anchor: mobileAnchor, chapterId: 'ed:2-ii' })?.identifier).toBe('2-ii')
      expect(chapterForHighlight(chapters, { anchor: mobileAnchor, chapterId: '' })).toBeUndefined()
    })
  })
})
