import { describe, it, expect } from 'vitest'
import {
  CELLULAR_WARN_BYTES,
  formatBytes,
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

describe('formatBytes', () => {
  it('reads the way a download button should', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    // A decimal only while it carries information: under 10 MB.
    expect(formatBytes(1536 * 1024)).toBe('1.5 MB')
    expect(formatBytes(21 * 1024 * 1024)).toBe('21 MB')
    expect(formatBytes(80 * 1024 * 1024)).toBe('80 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB')
  })

  it('says nothing rather than something wrong when the size is unknown', () => {
    expect(formatBytes(null)).toBeNull()
    expect(formatBytes(-1)).toBeNull()
    expect(formatBytes(Number.NaN)).toBeNull()
  })
})
