import { describe, it, expect } from 'vitest'
import { returnedToForeground } from './progressRestore'

describe('returnedToForeground (H3)', () => {
  it('background/inactive → active is a return', () => {
    expect(returnedToForeground('background', 'active')).toBe(true)
    expect(returnedToForeground('inactive', 'active')).toBe(true)
  })

  it('anything else is not', () => {
    expect(returnedToForeground('active', 'active')).toBe(false)
    expect(returnedToForeground('active', 'background')).toBe(false)
    expect(returnedToForeground('background', 'inactive')).toBe(false)
  })
})
