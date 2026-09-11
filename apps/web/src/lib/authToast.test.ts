import { describe, it, expect } from 'vitest'
import { authToastFor } from './authToast'

describe('authToastFor', () => {
  it('reassures a reader who just turned their guest session into an account', () => {
    expect(authToastFor(true, null)).toBe('success')
  })

  it('says nothing to a returning reader who simply signed in again', () => {
    // Nothing was at risk, so there is nothing to reassure them about.
    expect(authToastFor(false, null)).toBe(null)
  })

  it('warns instead of reassuring when the merge was skipped', () => {
    // The case this function exists for. Showing "your progress was kept" here is worse than
    // showing nothing: it is the sentence that stops the reader looking for what went missing.
    expect(authToastFor(true, 'merge_conflict')).toBe('merge-skipped')
    expect(authToastFor(true, 'invalid_token')).toBe('merge-skipped')
  })

  it('warns even when the reader was not a guest a moment ago', () => {
    // The server only reports a skip when a guest token WAS presented, so this combination means
    // the local view of "were they a guest" disagrees with the server's. Trust the server: it is
    // the side that knows whether anything was left behind.
    expect(authToastFor(false, 'merge_conflict')).toBe('merge-skipped')
  })
})
