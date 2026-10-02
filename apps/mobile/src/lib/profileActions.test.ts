import { describe, it, expect } from 'vitest'
import type { UserDto } from '@textstack/shared'
import { deleteGuestData, signOutIntent } from './profileActions'

const guest: UserDto = {
  id: 'g-1',
  email: 'guest-0f3a9c1e@guest.local',
  name: null,
  picture: null,
  createdAt: '2026-09-01T00:00:00Z',
  isGuest: true,
  nativeLanguage: null,
}

const account: UserDto = { ...guest, id: 'u-1', email: 'reader@example.com', name: 'Reader', isGuest: false }

describe('signOutIntent', () => {
  it('signed out: immediate — there is no session to lose', () => {
    expect(signOutIntent(null)).toBe('immediate')
  })

  it('account: immediate — an email and a password get all of it back', () => {
    expect(signOutIntent(account)).toBe('immediate')
  })

  /**
   * A guest has no "sign out": the device tokens are the only key to the row, so
   * the exit is "Delete guest data" — confirm, delete the row server-side, then
   * sign out. If this ever flips to 'immediate', one tap orphans everything again.
   */
  it('guest: delete-guest-data — the tokens on this device are the only key that exists', () => {
    expect(signOutIntent(guest)).toBe('delete-guest-data')
  })

  it('is decided by the guest flag alone, not by how furnished the profile looks', () => {
    const settledGuest: UserDto = { ...guest, name: 'Quiet Heron', picture: '/storage/avatars/g-1.jpg' }
    expect(signOutIntent(settledGuest)).toBe('delete-guest-data')
  })
})

describe('deleteGuestData', () => {
  function deps(over: Partial<Parameters<typeof deleteGuestData>[0]> = {}) {
    const calls: string[] = []
    return {
      calls,
      d: {
        getToken: async () => 'guest-token',
        deleteAccount: async (t: string) => { calls.push(`delete:${t}`) },
        signOut: async () => { calls.push('signOut') },
        ...over,
      },
    }
  }

  it('deletes the row on the server, then signs out', async () => {
    const { calls, d } = deps()
    await deleteGuestData(d)
    expect(calls).toEqual(['delete:guest-token', 'signOut'])
  })

  it('offline / server error: still signs out locally', async () => {
    const { calls, d } = deps({ deleteAccount: async () => { throw new TypeError('Network request failed') } })
    await deleteGuestData({ ...d, signOut: async () => { calls.push('signOut') } })
    expect(calls).toEqual(['signOut'])
  })

  it('no token (refresh failed): skips the call, still signs out', async () => {
    const { calls, d } = deps({ getToken: async () => null })
    await deleteGuestData(d)
    expect(calls).toEqual(['signOut'])
  })

  it('token read throws: still signs out', async () => {
    const { calls, d } = deps({ getToken: async () => { throw new Error('keychain') } })
    await deleteGuestData(d)
    expect(calls).toEqual(['signOut'])
  })
})
