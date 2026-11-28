// The platform seam's `account` on Android: the web AuthContext calls it with `api/auth.ts`'s signatures. The
// session is bearer mode, as in the Expo app: the tokens and the user row in secure storage, the auth routes through
// the shared `authApi` (`X-Client: mobile`). A new session claims the device library (#1070) and adopts a guest's
// (R6) here, before the UI sets the user: the identity is authoritative at this point (Expo `AuthContext`).
import { authApi, capabilitiesFor, type MergeMap } from '@textstack/shared'
import * as web from '../../api/auth'
import type { AuthResponse, User } from '../../api/auth'
import type { Platform } from '../index'
import { clearTokens, freshAccessToken, getAccessToken, onUnauthorized, resetAuthFailureLatch, writeTokens } from './api'
import { onAuthFailure } from './authEvents'
import { SecureStore } from './native'
import { createWriteQueue, writeUserIfCurrent, USER_KEY } from './sessionWrites'
import { adoptLocalAccount, claimLibraryFor, pushBeforeSignOut } from './librarySync'
import { clearWipePending, deviceOwnedLoss, deviceSignOutLoss, LIBRARY_WIPE_MS, rememberOwnerEmail, wipeDeviceLibrary } from './deviceLibrary'
import { forgetSyncAnswer, syncStore } from './syncClient'
import { withDeadline } from './deadline'

/** One queue and epoch for every session write (sessionWrites.ts): a guest mint that loses to a sign-in writes nothing. */
const queue = createWriteQueue()
/** The session's generation, bumped where the tokens change: work started under an earlier one is dropped (reader). */
export const sessionEpoch = () => queue.epoch

/** #1611: the guest mint's look at the device library (Expo `OWNED_LOSS_MINT_MS`). */
const OWNED_LOSS_MINT_MS = 1000

const noSession = (message: string) => Object.assign(new Error(message), { status: 401 })

/** The session's user as stored on the device (null: none, or unreadable). */
export async function storedUser(): Promise<User | null> {
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

/**
 * A new session (Expo `signInWithTokens`): tokens and user written, the caches reset, the library claimed, a guest's
 * adopted. `mintedAt`: a guest mint's epoch from before its call. The mint is dropped inside the queue when a session
 * changed since, or when a real account holds the device now (Expo `decideApplyGuest`).
 */
async function begin(res: NewSession, mintedAt?: number): Promise<AuthResponse> {
  if (mintedAt === undefined) queue.bumpEpoch() // synchronous, before anything can yield: a guest mint in flight loses
  await queue.run(async () => {
    const previous = await storedUser()
    if (mintedAt !== undefined && (queue.epoch !== mintedAt || (previous && !capabilitiesFor(previous).isGuest && (await getAccessToken().catch(() => null))))) {
      throw new Error('the session changed while the guest session was minted')
    }
    if (mintedAt !== undefined) queue.bumpEpoch()
    await writeTokens(res.accessToken, res.refreshToken)
    await SecureStore.setItemAsync(USER_KEY, JSON.stringify(res.user))
    // Another account's V2 cache must not answer this one; the V2 switch was the previous account's.
    syncStore.reset()
    if (previous?.id !== res.user.id) forgetSyncAnswer()
    await claimLibrary(res.user)
    // The library a guest synced becomes the account's: ids re-keyed, a full pull next. A failure never blocks sign-in.
    if (previous && capabilitiesFor(previous).isGuest && !capabilitiesFor(res.user).isGuest && previous.id !== res.user.id) {
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

/**
 * A terminal auth failure (api.ts: the server refused the refresh and the tokens are gone): the session's user and
 * caches go too, as in the Expo app. The device library stays (its owner is kept, so the next sign-in decides).
 * ponytail: the web AuthContext learns of it at the next start (the seam has no "signed out" event yet, wave 7).
 */
onAuthFailure(() => {
  queue.bumpEpoch()
  void queue.run(async () => { await SecureStore.deleteItemAsync(USER_KEY) }).catch(() => {})
  syncStore.reset()
  forgetSyncAnswer()
})

/** Sign-out with something only this device holds is refused until the UI can ask (wave 7, Expo `createAccountSignOut`). */
const SIGN_OUT_LOSES = 'signing out would delete books or changes that are only on this device'

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
    // Not awaited, so the reading path waits for nothing (Expo bootstrap): a claim a late or failed sign-in left
    // undone is tried again (#1070 rule B), and the profile is read once per start (a change made on another device).
    void claimLibrary(user)
    void authApi.getProfile(token).then(keepUser).catch(() => {})
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
    return begin(await authApi.createGuestSession(), epochAtStart)
  },
  /**
   * Sign-out (#1070): one push of the outbox first, then the loss check, then the session ends here, then the
   * server's logout (not awaited: a stalled network must not hold the sign-out). Fails closed: a loss, or a check
   * that cannot run, keeps the session and deletes nothing.
   */
  async logout() {
    const user = await storedUser()
    if (user) await pushBeforeSignOut(user.id, capabilitiesFor(user).isGuest)
    const loss = await withDeadline(deviceSignOutLoss(), LIBRARY_WIPE_MS).catch(() => null)
    if (!loss || loss.books > 0 || loss.writes > 0) throw new Error(SIGN_OUT_LOSES)
    const token = await getAccessToken().catch(() => null)
    await end()
    if (token) void authApi.logout(token).catch(() => {})
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
  // These go through `fetchInit` (the cached token, no retry on a 401): a fresh token first.
  approveDevice: async (userCode) => { await freshAccessToken(); return web.approveDevice(userCode) },
  denyDevice: async (userCode) => { await freshAccessToken(); return web.denyDevice(userCode) },
}
