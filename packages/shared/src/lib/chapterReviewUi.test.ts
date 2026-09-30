import { describe, it, expect } from 'vitest'
import { isReviewableChapter, reviewedHighlightMarks } from './chapterReviewUi'

describe('isReviewableChapter', () => {
  it.each([
    'Cover', 'Copyright', 'Contents', 'Table of Contents', 'INDEX', 'About the Author', 'About the Authors',
    'Acknowledgments', 'Acknowledgements', 'Dedication', 'Colophon', 'Also by Martin Kleppmann', 'Glossary',
    'Bibliography', 'References', 'Notes', '12. Index', 'IV - Glossary', 'Chapter 3: Notes',
  ])('hides %s', title => {
    expect(isReviewableChapter({ title, wordCount: 5000 })).toBe(false)
  })

  it.each(['Preface', 'Introduction', 'Epilogue', '1. Reliable, Scalable, and Maintainable Applications',
    'Notes on Distributed Systems', 'Indexing Strategies', 'Civil Notes'])('keeps %s', title => {
    expect(isReviewableChapter({ title, wordCount: 5000 })).toBe(true)
  })

  it('hides short chapters, keeps unknown length', () => {
    expect(isReviewableChapter({ title: 'Preface', wordCount: 799 })).toBe(false)
    expect(isReviewableChapter({ title: 'Preface', wordCount: 800 })).toBe(true)
    expect(isReviewableChapter({ title: 'Preface', wordCount: null })).toBe(true)
    expect(isReviewableChapter({ title: 'Preface' })).toBe(true)
    // PDF chapters often have no word count: hidden by title only.
    expect(isReviewableChapter({ title: 'Index', wordCount: null })).toBe(false)
  })
})

describe('reviewedHighlightMarks', () => {
  const block = (title: string, ids: string[]) => ({
    title, problem: 'p', rootCause: 'r', rule: `rule ${title}`, highlightIds: ids, question: { prompt: 'q', answer: 'a' },
  })
  const review = (blocks: ReturnType<typeof block>[]) =>
    ({ methodVersion: 2, recall: null, blocks, applications: [], openThreads: [], closedThreadIds: [] })

  it('maps every cited id (lower-cased) to its block; skips rows without a review', () => {
    const m = reviewedHighlightMarks([
      { chapterSlug: 'ch1', review: review([block('A', ['H1']), block('B', ['h2', 'h1'])]) },
      { chapterSlug: 'ch2', review: null },
      { chapterSlug: null, review: review([block('C', ['h3'])]) },
    ])
    expect([...m.keys()].sort()).toEqual(['h1', 'h2'])
    expect(m.get('h1')).toEqual({ chapterSlug: 'ch1', blockTitle: 'A', rule: 'rule A' })
    expect(m.get('h2')?.blockTitle).toBe('B')
  })
})
