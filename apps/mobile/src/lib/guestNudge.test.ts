import { describe, it, expect, beforeEach } from 'vitest'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { claimGuestNudge, pickGuestNudge } from './guestNudge'

const none = { three: false, ten: false }

describe('pickGuestNudge', () => {
  it('never for an account or no session', () => {
    expect(pickGuestNudge(false, 3, none)).toBeNull()
    expect(pickGuestNudge(false, 10, none)).toBeNull()
  })

  it('nothing before the 3rd word', () => {
    expect(pickGuestNudge(true, 1, none)).toBeNull()
    expect(pickGuestNudge(true, 2, none)).toBeNull()
  })

  it('3rd and 10th', () => {
    expect(pickGuestNudge(true, 3, none)).toBe('three')
    expect(pickGuestNudge(true, 10, { three: true, ten: false })).toBe('ten')
  })

  it('between thresholds, once three is spent: nothing', () => {
    expect(pickGuestNudge(true, 5, { three: true, ten: false })).toBeNull()
  })

  it('past 10 never says "3 words saved"', () => {
    expect(pickGuestNudge(true, 15, none)).toBe('ten')
    expect(pickGuestNudge(true, 15, { three: false, ten: true })).toBeNull()
  })
})

describe('claimGuestNudge — once per install', () => {
  beforeEach(() => (AsyncStorage as unknown as { __reset(): void }).__reset())

  it('shows each nudge once', async () => {
    expect(await claimGuestNudge(true, 3)).toBe('three')
    expect(await claimGuestNudge(true, 3)).toBeNull()
    expect(await claimGuestNudge(true, 4)).toBeNull()
    expect(await claimGuestNudge(true, 10)).toBe('ten')
    expect(await claimGuestNudge(true, 11)).toBeNull()
  })

  it('the 10th spends the 3rd too', async () => {
    expect(await claimGuestNudge(true, 12)).toBe('ten')
    expect(await claimGuestNudge(true, 3)).toBeNull()
  })

  it('an account spends nothing', async () => {
    expect(await claimGuestNudge(false, 3)).toBeNull()
    expect(await claimGuestNudge(true, 3)).toBe('three')
  })
})
