import { describe, it, expect } from 'vitest'
import { authToastFor } from './authToast'

const guest = { isGuest: true }
const account = { isGuest: false }

describe('authToastFor', () => {
  it('says "moved to your account" only for a guest whose merge the server confirmed', () => {
    expect(authToastFor(guest, null)).toBe('merged')
    expect(authToastFor(guest, undefined)).toBe('merged')
  })

  it('keeps the older "progress kept" for a reader who had no session at all', () => {
    expect(authToastFor(null, null)).toBe('saved')
  })

  it('says nothing to a returning reader who simply signed in again', () => {
    expect(authToastFor(account, null)).toBe(null)
  })

  it('warns instead of reassuring when the merge was skipped', () => {
    // Showing "your progress was kept" here is worse than showing nothing: it is the sentence
    // that stops the reader looking for what went missing.
    expect(authToastFor(guest, 'merge_conflict')).toBe('merge-skipped')
    expect(authToastFor(guest, 'invalid_token')).toBe('merge-skipped')
  })

  it('warns even when the reader was not a guest a moment ago', () => {
    // The server only reports a skip when a guest token WAS presented — trust it.
    expect(authToastFor(account, 'merge_conflict')).toBe('merge-skipped')
    expect(authToastFor(null, 'merge_conflict')).toBe('merge-skipped')
  })
})
