import { describe, expect, it } from 'vitest'
import { formatEtf, formatTimeLeft } from './timeEstimate'

describe('formatTimeLeft', () => {
  it('< 60m', () => { expect(formatTimeLeft(35)).toBe('~35m') })
  it('exactly 60m', () => { expect(formatTimeLeft(60)).toBe('1h') })
  it('h + m', () => { expect(formatTimeLeft(125)).toBe('2h 5m') })
  it('huge → no minutes', () => { expect(formatTimeLeft(3500)).toBe('~58h') })
  it('zero', () => { expect(formatTimeLeft(0)).toBe('0m') })
})

describe('formatEtf', () => {
  it('< 60m', () => { expect(formatEtf(35)).toBe('~35m') })
  it('whole hours', () => { expect(formatEtf(120)).toBe('~2h') })
  it('h + m', () => { expect(formatEtf(125)).toBe('~2h 5m') })
})
