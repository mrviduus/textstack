import { describe, it, expect, beforeEach } from 'vitest'
import { takeGuestNudge } from './guestNudge'

describe('takeGuestNudge', () => {
  beforeEach(() => localStorage.clear())

  it('fires at 3 and at 10, each once', () => {
    expect(takeGuestNudge(1)).toBe(null)
    expect(takeGuestNudge(2)).toBe(null)
    expect(takeGuestNudge(3)).toBe('three')
    expect(takeGuestNudge(4)).toBe(null)
    expect(takeGuestNudge(9)).toBe(null)
    expect(takeGuestNudge(10)).toBe('ten')
    expect(takeGuestNudge(11)).toBe(null)
  })

  it('jumping past 10 shows only the 10-word nudge', () => {
    expect(takeGuestNudge(12)).toBe('ten')
    expect(takeGuestNudge(13)).toBe(null)
  })

  it('remembers across calls via localStorage', () => {
    expect(takeGuestNudge(3)).toBe('three')
    expect(localStorage.getItem('guestNudge.three')).toBe('1')
  })
})
