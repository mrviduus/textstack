import { describe, it, expect } from 'vitest'
import { cachedUserBookDetail } from './cachedUserBookDetail'
import type { CachedUserBookMeta, CachedUserChapter } from './offlineDb'

const meta: CachedUserBookMeta = {
  bookId: 'book-1',
  title: 'Designing Data-Intensive Applications',
  author: 'Martin Kleppmann',
  coverPath: 'ab/book-1/cover.webp',
  language: 'en',
  totalChapters: 2,
  cachedChapters: 2,
  totalWordCount: 12000,
  isPdf: true,
  cachedAt: 1_757_000_000_000,
}

const chapter = (slug: string, n: number | null): CachedUserChapter => ({
  bookId: 'book-1',
  chapterSlug: slug,
  chapterId: `id-${slug}`,
  html: `<p>${slug}</p>`,
  title: slug.toUpperCase(),
  wordCount: 600,
  chapterNumber: n,
  sourceStartPage: n === null ? null : n * 10,
  prev: null,
  next: null,
  cachedAt: 1_757_000_000_000,
})

describe('cachedUserBookDetail', () => {
  it('reports Ready — a cached copy only exists for a processed book', () => {
    expect(cachedUserBookDetail(meta, [chapter('a', 0)]).status).toBe('Ready')
  })

  it('reports hasOriginalPdf false when the original is not on the device', () => {
    expect(cachedUserBookDetail(meta, [chapter('a', 0)]).hasOriginalPdf).toBe(false)
  })

  it('reports hasOriginalPdf true once the file is stored — offline it is the same book', () => {
    expect(cachedUserBookDetail(meta, [chapter('a', 0)], true).hasOriginalPdf).toBe(true)
  })

  it('carries title, author, cover and word count across', () => {
    const book = cachedUserBookDetail(meta, [chapter('a', 0)])
    expect(book.title).toBe(meta.title)
    expect(book.author).toBe('Martin Kleppmann')
    expect(book.coverPath).toBe(meta.coverPath)
    expect(book.totalWordCount).toBe(12000)
  })

  it('claims nothing it does not have', () => {
    const book = cachedUserBookDetail(meta, [chapter('a', 0)])
    expect(book.description).toBeNull()
    expect(book.genre).toBeNull()
    expect(book.publishedYear).toBeNull()
    expect(book.toc).toBeNull()
  })

  it('maps chapters in the order given, keeping slug and page', () => {
    const book = cachedUserBookDetail(meta, [chapter('one', 0), chapter('two', 1)])
    expect(book.chapters.map(c => c.slug)).toEqual(['one', 'two'])
    expect(book.chapters.map(c => c.chapterNumber)).toEqual([0, 1])
    expect(book.chapters[1].sourceStartPage).toBe(10)
  })

  it('numbers a chapter by its position when the cache has no ordinal', () => {
    const book = cachedUserBookDetail(meta, [chapter('one', null), chapter('two', null)])
    expect(book.chapters.map(c => c.chapterNumber)).toEqual([0, 1])
  })
})
