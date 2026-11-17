import { describe, it, expect } from 'vitest'
import { isReviewableChapter } from './chapterReviewUi'

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
