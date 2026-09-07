import { describe, it, expect } from 'vitest'
import type { UserDto } from '@textstack/shared'
import { capabilitiesFor } from './capabilities'

const guest: UserDto = {
  id: 'g-1',
  email: 'guest-0f3a9c1e@guest.local',
  name: null,
  picture: null,
  createdAt: '2026-09-01T00:00:00Z',
  isGuest: true,
  nativeLanguage: null,
}

const account: UserDto = {
  id: 'u-1',
  email: 'reader@example.com',
  name: 'Reader',
  picture: null,
  createdAt: '2026-09-01T00:00:00Z',
  isGuest: false,
  nativeLanguage: 'uk',
}

/**
 * Whole-object equality, on purpose.
 *
 * Asserting field by field would let the next capability added to this module
 * ship with no test covering the guest row — it would just inherit whatever the
 * implementation happened to default to, which is precisely the class of bug
 * this module exists to prevent. A literal `toEqual` breaks all three rows the
 * moment a field is added, forcing an explicit yes/no for a guest.
 */
describe('capabilitiesFor — the whole table', () => {
  it('signed out: no session, no policy', () => {
    expect(capabilitiesFor(null)).toEqual({
      hasSession: false,
      isGuest: false,
      isAccount: false,
      canUpload: false,
      canUseAi: false,
      canEditIdentity: false,
      canDeleteAccount: false,
      canSyncAcrossDevices: false,
      // Vacuous: nothing to sign out of, so nothing to warn about.
      canSignOutSilently: true,
    })
  })

  it('guest: a real session, no account', () => {
    expect(capabilitiesFor(guest)).toEqual({
      hasSession: true,
      isGuest: true,
      isAccount: false,
      // The one `true` on this row that is not a fact about the session: a
      // policy a guest is allowed. See the reason below.
      canUpload: true,
      canUseAi: false,
      canEditIdentity: false,
      canDeleteAccount: false,
      canSyncAcrossDevices: false,
      canSignOutSilently: false,
    })
  })

  it('account: everything', () => {
    expect(capabilitiesFor(account)).toEqual({
      hasSession: true,
      isGuest: false,
      isAccount: true,
      canUpload: true,
      canUseAi: true,
      canEditIdentity: true,
      canDeleteAccount: true,
      canSyncAcrossDevices: true,
      canSignOutSilently: true,
    })
  })
})

describe('hasSession', () => {
  it('is true for a guest because a guest is a real server-side user row that syncs', () => {
    // The fact this whole design rests on. Reading progress, highlights,
    // bookmarks and vocabulary all POST to /me/* for a guest exactly as they do
    // for an account, so the ~16 call sites reading `isAuthenticated` as "do I
    // have a token" stay correct and stay unmigrated.
    expect(capabilitiesFor(guest).hasSession).toBe(true)
  })
})

describe('policy flags, one reason each', () => {
  it('canUpload is TRUE for a guest — the Guest tier already grants one book at 50 MB', () => {
    // Reversed 2026-09-06 (ADR-014 §3). It was false on the argument that a
    // guest who loses the device loses their only book; the thesis is user
    // books first, and answering "bring the book you want to finish" with a
    // sign-in wall contradicts it. The server never refused this upload —
    // Entitlements:Tiers:Guest meters it exactly like anyone else's.
    expect(capabilitiesFor(guest).canUpload).toBe(true)
    expect(capabilitiesFor(account).canUpload).toBe(true)
  })

  it('canUpload is false with no session at all, because the upload needs a bearer token', () => {
    // Not `true` unconditionally: mobile mints a guest from one trigger only
    // (opening a book, via ReaderSessionGate), so an install that has only
    // browsed the catalog has no row to hang a file on. This is the line that
    // keeps `/my-books/upload` and the "+" tab asking for an account there.
    expect(capabilitiesFor(null).canUpload).toBe(false)
  })

  it('canUseAi stays account-only, and is deliberately NOT moved by the upload reversal', () => {
    // Different kind of decision: cost, on paid inference, enforced server-side
    // by RequireAiAccount() with a 403. Upload spends a tier allowance the tier
    // already has; AI spends money the tier does not.
    expect(capabilitiesFor(guest).canUpload).toBe(true)
    expect(capabilitiesFor(guest).canUseAi).toBe(false)
  })

  it('canUseAi is false for a guest because librarian and tutor call paid inference', () => {
    // Their rate-limit buckets partition on IP only, so an ungated guest path
    // is throttled by IP and by nothing else.
    expect(capabilitiesFor(guest).canUseAi).toBe(false)
    expect(capabilitiesFor(account).canUseAi).toBe(true)
  })

  it('canEditIdentity is false for a guest because its email and name are generated throwaways', () => {
    // guest-<hex>@guest.local + an anon display identity. Today the profile
    // screen still reaches PUT /me/profile for a guest; this is the flag that
    // stops it.
    expect(capabilitiesFor(guest).canEditIdentity).toBe(false)
    expect(capabilitiesFor(account).canEditIdentity).toBe(true)
  })

  it('canDeleteAccount is false for a guest because there is no account to delete', () => {
    expect(capabilitiesFor(guest).canDeleteAccount).toBe(false)
    expect(capabilitiesFor(account).canDeleteAccount).toBe(true)
  })

  it('canSyncAcrossDevices is false for a guest — the honest reason to sign up', () => {
    expect(capabilitiesFor(guest).canSyncAcrossDevices).toBe(false)
    expect(capabilitiesFor(account).canSyncAcrossDevices).toBe(true)
  })

  it('canSignOutSilently is false for a guest because the device tokens are the only handle on it', () => {
    // GuestCleanupWorker preserves a guest holding vocabulary, so the row
    // survives the sign-out — unreachable forever. Needs a destructive confirm.
    expect(capabilitiesFor(guest).canSignOutSilently).toBe(false)
    expect(capabilitiesFor(account).canSignOutSilently).toBe(true)
    // Not `isAccount`: signed out is already signed out.
    expect(capabilitiesFor(null).canSignOutSilently).toBe(true)
  })
})
