import { describe, it, expect } from 'vitest'
import {
  CELLULAR_WARN_BYTES,
  chooseEvictions,
  isOutOfSpaceError,
  originalFileName,
  shouldConfirmOnCellular,
} from './originalFilePolicy'

const ID = '3f2b1c4d-0000-4000-8000-000000000001'

describe('originalFileName', () => {
  it('names the file after the book and its format', () => {
    expect(originalFileName(ID, 'pdf')).toBe(`${ID}.pdf`)
    expect(originalFileName(ID, 'epub')).toBe(`${ID}.epub`)
  })

  it('refuses an id that could escape the directory', () => {
    expect(() => originalFileName('../../etc/passwd', 'pdf')).toThrow(/unsafe book id/)
    expect(() => originalFileName('a/b', 'pdf')).toThrow(/unsafe book id/)
    expect(() => originalFileName('..', 'pdf')).toThrow(/unsafe book id/)
    expect(() => originalFileName('', 'pdf')).toThrow(/unsafe book id/)
  })
})

describe('shouldConfirmOnCellular', () => {
  it('never asks on wifi, whatever the size', () => {
    expect(shouldConfirmOnCellular(80 * 1024 * 1024, false)).toBe(false)
    expect(shouldConfirmOnCellular(null, false)).toBe(false)
  })

  it('asks on cellular only once the file is worth asking about', () => {
    expect(shouldConfirmOnCellular(2 * 1024 * 1024, true)).toBe(false)
    expect(shouldConfirmOnCellular(CELLULAR_WARN_BYTES, true)).toBe(false)
    expect(shouldConfirmOnCellular(CELLULAR_WARN_BYTES + 1, true)).toBe(true)
    // The 21 MB reference document.
    expect(shouldConfirmOnCellular(21 * 1024 * 1024, true)).toBe(true)
  })

  it('treats an unknown size as large — the silent guess must not cost money', () => {
    expect(shouldConfirmOnCellular(null, true)).toBe(true)
  })
})

describe('chooseEvictions', () => {
  const entry = (bookId: string, bytes: number, lastUsedAt = 0) =>
    ({ name: `${bookId}.pdf`, bookId, bytes, lastUsedAt })

  it('does nothing while the cache is inside its budget', () => {
    expect(chooseEvictions([entry('a', 10), entry('b', 10)], 100, new Set())).toEqual([])
    // Exactly at budget is inside it.
    expect(chooseEvictions([entry('a', 100)], 100, new Set())).toEqual([])
  })

  it('evicts oldest first, and stops as soon as it is under budget', () => {
    const chosen = chooseEvictions(
      [entry('new', 60, 300), entry('old', 60, 100), entry('mid', 60, 200)],
      120,
      new Set(),
    )
    expect(chosen.map(e => e.bookId)).toEqual(['old'])
  })

  it('takes more than one when one is not enough', () => {
    const chosen = chooseEvictions(
      [entry('a', 50, 100), entry('b', 50, 200), entry('c', 50, 300)],
      60,
      new Set(),
    )
    expect(chosen.map(e => e.bookId)).toEqual(['a', 'b'])
  })

  it('never evicts a protected book, even when it is the oldest', () => {
    const chosen = chooseEvictions(
      [entry('reading', 60, 1), entry('other', 60, 999)],
      60,
      new Set(['reading']),
    )
    expect(chosen.map(e => e.bookId)).toEqual(['other'])
  })

  it('stays over budget rather than evicting a protected book', () => {
    // The only thing large enough to help is the one being read.
    const chosen = chooseEvictions([entry('reading', 500, 1)], 100, new Set(['reading']))
    expect(chosen).toEqual([])
  })
})

describe('isOutOfSpaceError', () => {
  it('recognises the shapes a full device actually throws', () => {
    expect(isOutOfSpaceError(new Error('SQLITE_FULL: database or disk is full'))).toBe(true)
    expect(isOutOfSpaceError(new Error('write ENOSPC: no space left on device'))).toBe(true)
    expect(isOutOfSpaceError('QuotaExceededError')).toBe(true)
  })

  it('does not mistake an ordinary failure for one', () => {
    expect(isOutOfSpaceError(new Error('Network request failed'))).toBe(false)
    expect(isOutOfSpaceError(new Error('401 Unauthorized'))).toBe(false)
    expect(isOutOfSpaceError(null)).toBe(false)
    expect(isOutOfSpaceError(undefined)).toBe(false)
  })
})
