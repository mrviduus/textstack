import { describe, it, expect } from 'vitest'
import { formatBytes } from './formatBytes'

describe('formatBytes', () => {
  it('reads the way the quota row and the download button both need', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(1536 * 1024)).toBe('1.5 MB')
    expect(formatBytes(21 * 1024 * 1024)).toBe('21.0 MB')
    expect(formatBytes(80 * 1024 * 1024)).toBe('80.0 MB')
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB')
  })

  it('says nothing rather than something wrong when the size is unknown', () => {
    expect(formatBytes(null)).toBeNull()
    expect(formatBytes(undefined)).toBeNull()
    expect(formatBytes(-1)).toBeNull()
    expect(formatBytes(Number.NaN)).toBeNull()
  })
})
