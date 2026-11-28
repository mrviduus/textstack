// The platform seam's `account` on Android: the web AuthContext calls it with `api/auth.ts`'s signatures. The
// session is bearer mode, as in the Expo app: the tokens and the user row in secure storage, the auth routes through
// the shared `authApi` (`X-Client: mobile`). A new session claims the device library (#1070) and adopts a guest's
// (R6) here, before the UI sets the user: the identity is authoritative at this point (Expo `AuthContext`).
import { authApi, capabilitiesFor, type MergeMap } from '@textstack/shared'
import * as web from '../../api/auth'
import type { AuthResponse, User } from '../../api/auth'
import type { Platform } from '../index'
import { clearTokens, getAccessToken, onUnauthorized, resetAuthFailureLatch, writeTokens } from './api'
import { SecureStore } from './native'
import { createWriteQueue, writeUserIfCurrent, USER_KEY } from './sessionWrites'
import { adoptLocalAccount, claimLibraryFor, pushBeforeSignOut } from './librarySync'
import { clearWipePending, deviceOwnedLoss, LIBRARY_WIPE_MS, rememberOwnerEmail, wipeDeviceLibrary } from './deviceLibrary'
import { forgetSyncAnswer, syncStore } from './syncClient'
import { withDeadline } from './deadline'

/** One queue and epoch for every session write (sessionWrites.ts): a guest mint that loses to a sign-in writes nothing. */
const queue = createWriteQueue()

/** #1611: the guest mint's look at the device library (Expo `OWNED_LOSS_MINT_MS`). */
const OWNED_LOSS_MINT_MS = 1000

const noSession = (message: string) => Object.assign(new Error(message), { status: 401 })

async function storedUser(): Promise<User | null> {
  try {
    const v = await SecureStore.getItemAsync(USER_KEY)
    return v ? (JSON.parse(v) as User) : null
  } catch {
    return null
  }
}

/**
 * Sign-in's another-account wipe (#1070 rule B), bounded; a failure or a late one only warns. Done, the library
 * belongs to this session: a sign-out wipe still owed is not (#1608), and its owner's email is this account's (#1611).
 */
const claimLibrary = (user: User) =>
  withDeadline(
    claimLibraryFor(user.id).then(clearWipePending).then(() => rememberOwnerEmail(capabilitiesFor(user).isGuest ? null : user.email)),
    LIBRARY_WIPE_MS,
  ).catch((e) => console.warn('[v2] sign-in wipe failed or late:', e))

interface NewSession { accessToken: string; refreshToken: string; user: User; guestMergeSkipped?: AuthResponse['guestMergeSkipped']; merge?: MergeMap }

/** A new session (Expo `signInWithTokens`): tokens and user written, the caches reset, the library claimed, a guest's adopted. */
async function begin(res: NewSession): Promise<AuthResponse> {
  // Synchronous, before anything can yield: an in-flight guest mint reads it to find that it lost.
  queue.bumpEpoch()
  await queue.run(async () => {
    const previous = await storedUser()
    await writeTokens(res.accessToken, res.refreshToken)
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(res.user))
    // Another account's V2 cache must not answer this one; the V2 switch was the previous account's.
    syncStore.reset()
    if (previous?.id !== res.user.id) forgetSyncAnswer()
    await claimLibrary(res.user)
    // The library a guest synced becomes the account's: ids re-keyed, a full pull next. A failure never blocks sign-in.
    if (previous && capabilitiesFor(previous).isGuest && previous.id !== res.user.id) {
      await adoptLocalAccount(previous.id, res.user.id, res.merge).catch((e) => console.warn('[v2] local library not moved to the account:', e))
    }
    resetAuthFailureLatch()
  })
  return { user: res.user, guestMergeSkipped: res.guestMergeSkipped, merge: res.merge }
}

/**
 * The session ends here (sign-out, a deleted account): tokens and user gone, the caches reset, the device library
 * wiped (#1070: V2 books belong to the account). Bounded: a hung database open must not hold the queue; a failed or
 * late wipe only warns (the library keeps its owner, so another account's passes are refused and its sign-in wipes).
 */
async function end(): Promise<void> {
  queue.bumpEpoch()
  await queue.run(async () => {
    await clearTokens().catch(() => {})
    await SecureStore.deleteItemAsync(USER_KEY).catch(() => {})
    syncStore.reset()
    forgetSyncAnswer()
    await withDeadline(wipeDeviceLibrary(), LIBRARY_WIPE_MS).catch((e) => console.warn('[v2] sign-out wipe failed or late:', e))
  })
}

/** A profile answer kept as the session's user, unless the session changed meanwhile (sessionWrites.ts). */
async function keepUser(res: AuthResponse): Promise<AuthResponse> {
  await writeUserIfCurrent({ queue, store: SecureStore, json: JSON.stringify(res.user), onApplied: () => {} })
  return res
}

export const account: Platform['account'] = {
  /** The stored session, with no network: reading on the phone needs no server (a 401-like error when there is none). */
  async getCurrentUser() {
    const user = await storedUser()
    const token = await getAccessToken().catch(() => null)
    if (!user || !token) throw noSession('No session on this device')
    return { user }
  },
  async refreshToken() {
    const user = await storedUser()
    if (!user || !(await onUnauthorized())) throw noSession('Session refresh failed')
    return { user }
  },
  loginWithEmail: async (email, password) => begin(await authApi.loginWithEmail(email, password)),
  registerWithEmail: async (email, password, name) => begin(await authApi.registerWithEmail(email, password, name)),
  loginWithGoogle: async (idToken) => begin(await authApi.loginWithGoogle(idToken)),
  async createGuestSession() {
    // Captured before the first await (the epoch contract).
    const epochAtStart = queue.epoch
    // #1611: a guest's claim would wipe a real account's books that only this phone holds: no mint, no server call.
    // 'unknown' (unreadable or late) mints: the claim reads the same database, and a claim that cannot read it wipes nothing.
    const owned = await deviceOwnedLoss(OWNED_LOSS_MINT_MS)
    if (owned && owned.loss !== 'unknown') throw new Error("the device library holds another account's unsynced books")
    const res = await authApi.createGuestSession()
    if (queue.epoch !== epochAtStart) throw new Error('the session changed while the guest session was minted')
    return begin(res)
  },
  /** Sign-out (#1070): one push of the outbox first, then the server's logout, then the session ends here. */
  async logout() {
    const user = await storedUser()
    if (user) await pushBeforeSignOut(user.id, capabilitiesFor(user).isGuest)
    const token = await getAccessToken().catch(() => null)
    if (token) await authApi.logout(token).catch(() => {})
    await end()
  },
  forgotPassword: (email) => authApi.forgotPassword(email),
  resetPassword: (token, password) => authApi.resetPassword(token, password),
  updateProfile: async (payload) => keepUser(await web.updateProfile(payload)),
  uploadAvatar: async (file) => keepUser(await web.uploadAvatar(file)),
  async deleteAvatar() {
    await web.deleteAvatar()
    const user = await storedUser()
    if (user) await keepUser({ user: { ...user, picture: null } })
  },
  async deleteAccount() {
    await web.deleteAccount()
    await end()
  },
  approveDevice: (userCode) => web.approveDevice(userCode),
  denyDevice: (userCode) => web.denyDevice(userCode),
}
