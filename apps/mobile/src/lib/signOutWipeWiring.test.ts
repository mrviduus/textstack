import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * AuthContext is not renderable here (no RN renderer), so its sign-out's V2 wipe is pinned by source
 * (#1070): inside `signOut`, after the epoch bump, bounded by a deadline (a hung database open must
 * not hold the auth queue, which sign-in waits on), before the session is cleared in state.
 */
const src = readFileSync(resolve(__dirname, '../context/AuthContext.tsx'), 'utf8')
const signOut = src.slice(src.indexOf('const signOut = useCallback'), src.indexOf('}, [runExclusive])', src.indexOf('const signOut = useCallback')))

/** The source between `from` and the first `to` after it. */
const between = (from: string, to: string) => {
  const a = src.indexOf(from)
  return src.slice(a, src.indexOf(to, a))
}

describe('sign-in V2 wipe wiring (#1070 rule B: another account wipes at sign-in)', () => {
  it('claim_BoundedByTheWipeDeadline', () => {
    expect(src).toMatch(/const claimLibrary = \(userId: string\) =>\s+withDeadline\(claimLibraryFor\(userId\)\.then\(clearWipePending\), LIBRARY_WIPE_MS\)/)
  })

  it('signInWithTokens_ClaimAfterTheEpochBumpBeforeAdoptAndSetUser', () => {
    const fn = between('const signInWithTokens = useCallback', '[runExclusive],')
    const claim = fn.indexOf('await claimLibrary(userData.id)')
    expect(claim).toBeGreaterThan(fn.indexOf('syncStore.reset()'))
    expect(claim).toBeLessThan(fn.indexOf('adoptLocalAccount('))
    expect(claim).toBeLessThan(fn.indexOf('setUser(userData)'))
    // Whether the previous session was a guest goes through capabilities (ADR-014).
    expect(fn).toContain('capabilitiesFor(previous).isGuest')
  })

  it('guestMint_ClaimBeforeSetUser', () => {
    const fn = between('const createGuestOnce = useCallback', '[runExclusive])')
    const claim = fn.indexOf('await claimLibrary(res.user.id)')
    expect(claim).toBeGreaterThan(-1)
    expect(claim).toBeLessThan(fn.indexOf('setUser(res.user)'))
  })

  it('restoredSession_ClaimRetriedNotAwaited', () => {
    expect(between('// Restore session on mount', 'sessionReadyRef.current')).toContain('void claimLibrary(restored.id)')
  })
})

// #1611: another account's books only on this phone are asked about before any server call; a guest mint never asks.
describe('sign-in over another account\'s unsynced books (#1611)', () => {
  const login = readFileSync(resolve(__dirname, '../../app/(auth)/login.tsx'), 'utf8')
  /** The handler's source from `name` to the next handler. */
  const handler = (name: string) => login.slice(login.indexOf(`const ${name} = async`), login.indexOf('\n  const ', login.indexOf(`const ${name} = async`) + 1))

  it('everySignIn_AsksBeforeItsServerCall', () => {
    const email = handler('handleEmailAuth')
    const ask = email.indexOf('confirmLibraryLoss()')
    expect(ask).toBeGreaterThan(-1)
    for (const call of ['authApi.registerWithEmail(', 'authApi.loginWithEmail(']) expect(email.indexOf(call)).toBeGreaterThan(ask)
    for (const [name, call] of [['handleGoogleSignIn', 'authApi.loginWithGoogle('], ['handleAppleSignIn', 'authApi.loginWithApple(']]) {
      const fn = handler(name)
      expect(fn.indexOf('confirmLibraryLoss()'), name).toBeGreaterThan(-1)
      expect(fn.indexOf(call), name).toBeGreaterThan(fn.indexOf('confirmLibraryLoss()'))
    }
  })

  it('guestMint_LossOrUnknownMintsNothing', () => {
    const fn = between('const createGuestOnce = useCallback', '[runExclusive])')
    const check = fn.indexOf('await deviceOwnedLoss()) !== null')
    expect(check).toBeGreaterThan(-1)
    expect(check).toBeLessThan(fn.indexOf('authApi.createGuestSession()'))
  })
})

describe('sign-out V2 wipe wiring', () => {
  it('signOut_WipesTheV2LibraryBoundedAfterTheEpochBumpBeforeSetUser', () => {
    const wipe = signOut.indexOf('await withDeadline(wipeDeviceLibrary(), ')
    expect(wipe).toBeGreaterThan(signOut.indexOf('syncStore.reset()'))
    expect(wipe).toBeGreaterThan(signOut.indexOf('bumpEpoch()'))
    expect(wipe).toBeLessThan(signOut.indexOf('setUser(null)'))
  })
})
