import { describe, it, expect, beforeEach } from 'vitest'
import { createTextAnchor, findTextByAnchor } from './textAnchor'
import type { TextAnchor } from './offlineDb'

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
  })
})
