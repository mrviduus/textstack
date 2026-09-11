import { describe, it, expect } from 'vitest'
import { insightDateLabel } from './insightScope'

describe('insightDateLabel', () => {
  it('dates a conclusion by when it was last written, not when it was created', () => {
    // A re-run REPLACES the row and moves updatedAt. The reader asking "is this still what I think"
    // is asking about the text in front of them, which is the updated one.
    expect(insightDateLabel({ updatedAt: '2026-09-10T22:31:00+00:00' })).toBe('2026-09-10')
  })

  it('normalises an offset rather than shifting the day', () => {
    // 23:30 in +03:00 is still the 10th in UTC. Picking the local calendar day here would make the
    // same insight show two different dates on two devices.
    expect(insightDateLabel({ updatedAt: '2026-09-11T02:30:00+03:00' })).toBe('2026-09-10')
  })

  it('returns null for an unparseable timestamp instead of printing Invalid Date', () => {
    expect(insightDateLabel({ updatedAt: 'not a date' })).toBeNull()
    expect(insightDateLabel({ updatedAt: '' })).toBeNull()
  })
})
