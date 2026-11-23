import { describe, it, expect } from 'vitest'
import { cachedUserBookDetail } from './cachedUserBookDetail'
import type { LibraryBook } from './reader/hostStorage'

const onDevice: LibraryBook = {
  id: 'book-1', sha256: 'a'.repeat(64), size: 1000, title: 'Designing Data-Intensive Applications',
  author: 'Martin Kleppmann', originalName: 'ddia.epub', importedAt: 1_757_000_000_000, openedAt: 0,
  local: true, notSynced: null, finished: false, format: 'epub',
}

describe('cachedUserBookDetail', () => {
  it('offline, a book whose file is on the device opens: Ready, with its file, title and author', () => {
    const book = cachedUserBookDetail(onDevice)
    expect(book).toMatchObject({ id: 'book-1', status: 'Ready', hasFile: true, title: onDevice.title, author: 'Martin Kleppmann' })
  })

  it('claims nothing the device does not have', () => {
    const book = cachedUserBookDetail({ ...onDevice, author: '' })
    expect(book.author).toBeNull()
    expect(book.description).toBeNull()
    expect(book.coverPath).toBeNull()
    expect(book.chapters).toEqual([])
  })
})
