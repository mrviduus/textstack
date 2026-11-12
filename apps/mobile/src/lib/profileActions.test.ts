import { describe, it, expect, vi } from 'vitest'
import type { UserDto } from '@textstack/shared'
import { createAccountSignOut, deleteGuestData, signOutIntent, type V2SignOutDeps } from './profileActions'

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

describe('createAccountSignOut (#1070: sign-out wipes the V2 library)', () => {
  const v2 = (over: (calls: string[]) => Partial<V2SignOutDeps> = () => ({})) => {
    const calls: string[] = []
    const d: V2SignOutDeps = {
      syncFirst: async () => { calls.push('sync') },
      loss: async () => { calls.push('loss'); return { books: 0, writes: 0 } },
      confirm: async (loss) => { calls.push(`confirm:${JSON.stringify(loss)}`); return true },
      signOut: async () => { calls.push('signOut') },
      ...over(calls),
    }
    return { calls, d }
  }

  it('nothingLost_SyncedFirstThenSignedOutWithoutAConfirm', async () => {
    const { calls, d } = v2()
    expect(await createAccountSignOut()(d)).toBe(true)
    expect(calls).toEqual(['sync', 'loss', 'signOut'])
  })

  it('somethingLost_ConfirmWithTheCounts_CancelKeepsTheSession', async () => {
    const { calls, d } = v2((c) => ({
      loss: async () => ({ books: 2, writes: 1 }),
      confirm: async (l) => { c.push(`confirm:${JSON.stringify(l)}`); return false },
    }))
    expect(await createAccountSignOut()(d)).toBe(false)
    expect(calls).toEqual(['sync', 'confirm:{"books":2,"writes":1}'])
  })

  it('lossCheckFails_FailsClosed_GenericConfirmNeverStraightToTheWipe', async () => {
    const { calls, d } = v2(() => ({ loss: async () => { throw new Error('db') } }))
    expect(await createAccountSignOut()(d)).toBe(true)
    expect(calls).toEqual(['sync', 'confirm:null', 'signOut'])
  })

  it('syncFails_StillChecksAndSignsOut', async () => {
    const { calls, d } = v2(() => ({ syncFirst: async () => { throw new Error('offline') } }))
    expect(await createAccountSignOut()(d)).toBe(true)
    expect(calls).toEqual(['loss', 'signOut'])
  })

  it('doubleTap_OneSyncOneConfirmOneSignOut', async () => {
    let answer!: (yes: boolean) => void
    const { calls, d } = v2((c) => ({
      loss: async () => ({ books: 1, writes: 0 }),
      confirm: () => { c.push('confirm'); return new Promise<boolean>((r) => { answer = r }) },
    }))
    const signOut = createAccountSignOut()
    const first = signOut(d)
    const second = signOut(d)
    await vi.waitFor(() => expect(calls).toContain('confirm'))
    answer(true)
    expect(await Promise.all([first, second])).toEqual([true, true])
    expect(calls).toEqual(['sync', 'confirm', 'signOut'])
  })
})
