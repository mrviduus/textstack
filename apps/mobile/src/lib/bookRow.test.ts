import { describe, it, expect } from 'vitest'
import type { LibraryEntry, ReadingProgressDto } from '@textstack/shared'
import { bookRowModel } from './bookRow'

const NOW = Date.parse('2026-10-16T12:00:00Z')
const HOUR = 3600_000

const upload = (over: Record<string, unknown> = {}) =>
  ({
    kind: 'upload',
    book: { id: 'u1', title: 'Disgrace', status: 'Ready', completedAt: null, createdAt: null, progressUpdatedAt: null, errorMessage: null, ...over },
  }) as unknown as LibraryEntry
const saved = (over: Record<string, unknown> = {}) =>
  ({ kind: 'saved', item: { slug: 'dracula', editionId: 'e1', title: 'Dracula', ...over } }) as unknown as LibraryEntry
const noProgress: Record<string, ReadingProgressDto> = {}

describe('bookRowModel status', () => {
  it('a ready upload is ready, not dimmed, no pill', () => {
    const m = bookRowModel(upload(), noProgress, NOW)
    expect(m).toMatchObject({ isReady: true, dimmed: false, isFailed: false, pill: null })
  })

  it('processing upload: dimmed, pill "processing"; failed upload: pill "failed"', () => {
    expect(bookRowModel(upload({ status: 'Processing' }), noProgress, NOW)).toMatchObject({ isReady: false, dimmed: true, pill: 'processing' })
    expect(bookRowModel(upload({ status: 'Failed' }), noProgress, NOW)).toMatchObject({ isFailed: true, pill: 'failed' })
  })

  it('"completed" counts as ready', () => {
    expect(bookRowModel(upload({ status: 'completed' }), noProgress, NOW).isReady).toBe(true)
  })

  it('a catalog book is always ready', () => {
    expect(bookRowModel(saved(), noProgress, NOW)).toMatchObject({ isReady: true, dimmed: false, pill: null })
  })
})

describe('bookRowModel "new" pill', () => {
  it('shows for an upload created under 24 h ago, never read as finished', () => {
    const fresh = new Date(NOW - 23 * HOUR).toISOString()
    expect(bookRowModel(upload({ createdAt: fresh }), noProgress, NOW).pill).toBe('new')
  })

  it('not after 24 h, with a bad date, or once finished', () => {
    expect(bookRowModel(upload({ createdAt: new Date(NOW - 25 * HOUR).toISOString() }), noProgress, NOW).pill).toBeNull()
    expect(bookRowModel(upload({ createdAt: 'nope' }), noProgress, NOW).pill).toBeNull()
    expect(bookRowModel(upload({ createdAt: new Date(NOW - HOUR).toISOString(), completedAt: '2026-10-16' }), noProgress, NOW).pill).toBeNull()
  })

  it('processing outranks "new"', () => {
    const fresh = new Date(NOW - HOUR).toISOString()
    expect(bookRowModel(upload({ status: 'Processing', createdAt: fresh }), noProgress, NOW).pill).toBe('processing')
  })
})

describe('bookRowModel finished and last read', () => {
  it('an upload with completedAt is finished at any percent', () => {
    expect(bookRowModel(upload({ completedAt: '2026-10-01' }), noProgress, NOW).isFinished).toBe(true)
  })

  it('a saved book is finished at 100% from the progress map, and its lastRead comes from there', () => {
    const progress = { e1: { editionId: 'e1', percent: 1, updatedAt: '2026-10-15T00:00:00Z' } } as unknown as Record<string, ReadingProgressDto>
    const m = bookRowModel(saved(), progress, NOW)
    expect(m.isFinished).toBe(true)
    expect(m.pct).toBe(100)
    expect(m.lastRead).toBe('2026-10-15T00:00:00Z')
  })

  it('an upload takes lastRead from progressUpdatedAt; an untouched book has none', () => {
    expect(bookRowModel(upload({ progressUpdatedAt: '2026-10-14T00:00:00Z' }), noProgress, NOW).lastRead).toBe('2026-10-14T00:00:00Z')
    expect(bookRowModel(saved(), noProgress, NOW).lastRead).toBeUndefined()
  })

  it('a failed upload carries its error message; other books have none', () => {
    expect(bookRowModel(upload({ status: 'Failed', errorMessage: 'bad epub' }), noProgress, NOW).errorMessage).toBe('bad epub')
    expect(bookRowModel(saved(), noProgress, NOW).errorMessage).toBeUndefined()
  })

  it('a saved book with no title falls back to "Untitled" too', () => {
    expect(bookRowModel(saved({ title: '' }), noProgress, NOW).title).toBe('Untitled')
  })

  it('title falls back to "Untitled"', () => {
    expect(bookRowModel(upload({ title: '' }), noProgress, NOW).title).toBe('Untitled')
  })
})
