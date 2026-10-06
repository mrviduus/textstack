import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fillChapterLinks } from './chapterLinks'

const list = [{ slug: 'a', title: 'A' }, { slug: 'b', title: 'B' }, { slug: 'c', title: 'C' }]

describe('fillChapterLinks', () => {
  it('a stored chapter saved with no back link (before `previous` was mapped) gets it from the list', () => {
    expect(fillChapterLinks({ prev: null, next: { slug: 'c', title: 'C' } }, list, 'b'))
      .toEqual({ prev: { slug: 'a', title: 'A' }, next: { slug: 'c', title: 'C' } })
  })

  it('never overrides a link the chapter carries', () => {
    const own = { prev: { slug: 'x', title: 'X' }, next: null }
    expect(fillChapterLinks(own, list, 'c')).toEqual({ prev: { slug: 'x', title: 'X' }, next: null })
  })

  it('first chapter, unknown slug or no list → left as it is', () => {
    expect(fillChapterLinks({ prev: null, next: null }, list, 'a').prev).toBeNull()
    expect(fillChapterLinks({ prev: null, next: null }, list, 'zz')).toEqual({ prev: null, next: null })
    expect(fillChapterLinks({ prev: null, next: null }, [], 'b')).toEqual({ prev: null, next: null })
  })
})

describe('upload reader wiring', () => {
  it('the chapter it hands the shell has its links filled from the chapter list', () => {
    const src = readFileSync(resolve(__dirname, '../components/reader/useUserBookReaderSource.ts'), 'utf8')
    expect(src).toMatch(/chapter: chapter\s*\?\s*fillChapterLinks\(\{[^}]*\}, chapters, chapterSlug\)/)
  })
})
