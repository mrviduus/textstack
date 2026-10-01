import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import { Platform } from 'react-native'
import type { UserDto } from '@textstack/shared'
import { authApi } from '@textstack/shared'
import { onAuthFailure } from '../lib/authEvents'
import { resetAuthFailureLatch } from '../lib/api'
import { createSingleFlight } from '../lib/singleFlight'
import { createWriteQueue, writeUserIfCurrent } from '../lib/sessionWrites'
import {
  decideMint,
  decideApplyGuest,
  SESSION_BOOTSTRAP_TIMEOUT_MS,
  type EnsureSessionResult,
} from '../lib/guestSession'
import { clearAllLocalProgress } from '../lib/progressStorage'
import { clearReaderCache } from '../lib/readerOfflineCache'

// Lazy import so the Google module isn't pulled on platforms / contexts
// that don't ship it (e.g. Expo Go web preview, where this package may
// not be installed yet). Lives in a try/catch because the module's
// presence is not guaranteed across all build flavors.
let googleSigninModule: { GoogleSignin?: { signOut?: () => Promise<unknown> } } | null = null
if (Platform.OS !== 'web') {
  try {
    googleSigninModule = require('@react-native-google-signin/google-signin')
  } catch {
    googleSigninModule = null
  }
}

// Storage shim: native → expo-secure-store, web → localStorage.
//
// Previously each method called `require('expo-secure-store')` lazily on
// every call — extra work per auth op and a pathological crash risk if
// the module is missing. Now resolved once at module load behind a
// Platform guard (B-08). On web we keep a localStorage path (checked for
// existence because SSR is theoretically possible).
type NativeSecureStore = {
  getItemAsync: (key: string) => Promise<string | null>
  setItemAsync: (key: string, value: string) => Promise<void>
  deleteItemAsync: (key: string) => Promise<void>
}

let nativeStore: NativeSecureStore | null = null
if (Platform.OS !== 'web') {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    nativeStore = require('expo-secure-store') as NativeSecureStore
  } catch (err) {
    console.error('[auth] expo-secure-store unavailable — falling back to in-memory store. Sessions will NOT persist.', err)
  }
}

const hasWebStorage = typeof globalThis !== 'undefined' && typeof (globalThis as any).localStorage !== 'undefined'

// In-memory fallback so the app doesn't crash if both stores are
// unavailable. Sessions won't persist across reload, but tokens still
// work within the current app lifetime.
const memStore = new Map<string, string>()

const SecureStore = {
  async getItemAsync(key: string): Promise<string | null> {
    if (Platform.OS === 'web') {
      return hasWebStorage ? (globalThis as any).localStorage.getItem(key) : (memStore.get(key) ?? null)
    }
    if (nativeStore) return nativeStore.getItemAsync(key)
    return memStore.get(key) ?? null
  },
  async setItemAsync(key: string, value: string): Promise<void> {
    if (Platform.OS === 'web') {
      if (hasWebStorage) (globalThis as any).localStorage.setItem(key, value)
      else memStore.set(key, value)
      return
    }
    if (nativeStore) return nativeStore.setItemAsync(key, value)
    memStore.set(key, value)
  },
  async deleteItemAsync(key: string): Promise<void> {
    if (Platform.OS === 'web') {
      if (hasWebStorage) (globalThis as any).localStorage.removeItem(key)
      else memStore.delete(key)
      return
    }
    if (nativeStore) return nativeStore.deleteItemAsync(key)
    memStore.delete(key)
  },
}

interface AuthState {
  user: UserDto | null
  /** There is a session — guest or account. Unchanged: `user !== null`. */
  isAuthenticated: boolean
  // Deliberately NO `isGuest` here. Guest policy is decided once, in
  // `src/lib/capabilities.ts` (`capabilitiesFor(user)`), and every consumer
  // goes through it. A second copy on this value had zero call sites and was a
  // hole in the guard: `capabilityLiterals.test.ts` bans `user?.isGuest` and
  // `!isGuest &&`, but `const { isGuest } = useAuth()` followed by
  // `disabled={isGuest}` would have sailed straight past it. Two sources of
  // truth for one policy is how the profile screen shipped the pencil bug.
  isLoading: boolean
  signInWithTokens: (accessToken: string, refreshToken: string, user: UserDto) => Promise<void>
  updateUser: (user: UserDto) => Promise<void>
  getAccessToken: () => Promise<string | null>
  signOut: () => Promise<void>
  /**
   * Make sure there is *some* server session, minting an anonymous one if
   * there is not. Demand-driven — called when the user commits to something
   * that needs to be saved (opening a book), never at app launch.
   *
   * Never throws and never rejects: callers include fire-and-forget paths.
   * The returned status is how a caller tells "you already had a session"
   * (`existing`) from "minting failed" (`failed`) — the distinction web
   * silently drops.
   */
  ensureSession: () => Promise<EnsureSessionResult>
  /**
   * Resolve once the bootstrap SecureStore read has settled (or its timeout
   * elapsed). Lets a caller avoid acting on the `user === null` that merely
   * means "we have not looked yet".
   */
  waitForSession: () => Promise<void>
}

const AuthContext = createContext<AuthState>({
  user: null,
  isAuthenticated: false,
  isLoading: true,
  signInWithTokens: async () => {},
  updateUser: async () => {},
  getAccessToken: async () => null,
  signOut: async () => {},
  // Outside a provider there is nothing to mint with. Report it as a failure
  // rather than pretending a session exists — the reader gate treats a failure
  // as "open the book signed out", which is the right fallback here too.
  ensureSession: async () => ({ status: 'failed', error: new Error('AuthProvider is missing') }),
  waitForSession: async () => {},
})

export function useAuth() {
  return useContext(AuthContext)
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const userRef = useRef<UserDto | null>(null)
  userRef.current = user
  // Callbacks below are created once (empty dep arrays) and would otherwise
  // close over the first render's `isLoading`.
  const isLoadingRef = useRef(true)
  isLoadingRef.current = isLoading

  /**
   * The serial write queue and the session epoch — both live in
   * `src/lib/sessionWrites.ts` so they can actually be tested (Vitest collects
   * `src/lib/**` only, and this concurrency is where the bugs are). See that
   * module for why each exists; the contract here is just: bump the epoch
   * synchronously before any `await` in an operation that replaces the
   * session, and do every SecureStore write inside `run`.
   */
  const queueRef = useRef(createWriteQueue())
  const runExclusive = useCallback(<T,>(fn: () => Promise<T>): Promise<T> => {
    return queueRef.current.run(fn)
  }, [])

  /**
   * Resolves when the bootstrap read below settles. Created during the first
   * render (not in an effect) so a `waitForSession()` from a route that mounts
   * in the same commit has something to await.
   */
  const sessionReadyRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null)
  if (!sessionReadyRef.current) {
    let resolveFn: () => void = () => {}
    const promise = new Promise<void>((r) => { resolveFn = r })
    sessionReadyRef.current = { promise, resolve: resolveFn }
  }

  // Restore session on mount
  useEffect(() => {
    ;(async () => {
      try {
        const stored = await SecureStore.getItemAsync('user')
        if (stored) {
          const restored = JSON.parse(stored) as UserDto
          // The ref is written HERE, synchronously, and not left to the render
          // that `setUser` schedules. `sessionReadyRef.resolve()` below runs in
          // this same tick and releases everything parked in
          // `waitForSession()`; those continuations resume as microtasks, which
          // is BEFORE React commits. `decideMint` reads `userRef.current`, so
          // it would see null for a reader who does have a stored session — and
          // mint a fresh guest over the top of it.
          //
          // That is not theoretical. Five guest users appeared on production
          // from one device in two hours: each launch restored a session and
          // then immediately minted a new one, orphaning the previous guest's
          // library on the server while the reader watched their books vanish.
          // `authBootstrapOrder.test.ts` fails if this line is removed, because
          // it looks redundant next to the `userRef.current = user` a few lines
          // above and is exactly what a later cleanup deletes.
          userRef.current = restored
          setUser(restored)
        }
      } catch {
        // ignore
      } finally {
        isLoadingRef.current = false
        setIsLoading(false)
        // Unblocks anything parked in waitForSession(). Must be in the same
        // `finally` as setIsLoading — a bootstrap that threw still counts as
        // settled, and leaving this unresolved would park the reader gate
        // until its own deadline.
        sessionReadyRef.current!.resolve()
      }
    })()
  }, [])

  // Refresh the cached user from the server once per session so a profile field
  // changed on another device (notably nativeLanguage, set on the web) shows up
  // without re-login — the reader's translation gloss depends on it. Read-only;
  // transient/offline failures keep the cached user. Keyed on user id so it runs
  // once per account, not on every user-object update.
  useEffect(() => {
    if (!user || user.isGuest) return
    const cachedNative = user.nativeLanguage
    const cachedName = user.name
    let cancelled = false
    ;(async () => {
      try {
        const token = await SecureStore.getItemAsync('access_token')
        if (!token || cancelled) return
        const res = await authApi.getProfile(token)
        if (cancelled || !res?.user) return
        if (res.user.nativeLanguage !== cachedNative || res.user.name !== cachedName) {
          await updateUser(res.user)
        }
      } catch {
        // offline / transient — keep the cached user
      }
    })()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  const signInWithTokens = useCallback(
    async (accessToken: string, refreshToken: string, userData: UserDto) => {
      // Synchronous, and before anything can yield: this is what an in-flight
      // guest mint reads to discover that it lost.
      queueRef.current.bumpEpoch()
      await runExclusive(async () => {
        await SecureStore.setItemAsync('access_token', accessToken)
        await SecureStore.setItemAsync('refresh_token', refreshToken)
        await SecureStore.setItemAsync('user', JSON.stringify(userData))
        // Fresh session — allow the next terminal auth failure to fire
        // again (the latch is one-shot per session).
        resetAuthFailureLatch()
        setUser(userData)
      })
    },
    [runExclusive],
  )

  const updateUser = useCallback(async (userData: UserDto) => {
    // No epoch bump — this edits the current session's profile, it does not
    // replace the session — but it MUST read the epoch, which is the bug that
    // shipped: `updateUser` was the one queued writer that ignored it and
    // could therefore rewrite the `user` key after `signOut()` had already
    // deleted all three, leaving a user with no tokens and an app that
    // 401-loops forever. Both guards (epoch, and "there are still tokens")
    // live in `writeUserIfCurrent`, with the reasoning.
    await writeUserIfCurrent({
      queue: queueRef.current,
      store: SecureStore,
      json: JSON.stringify(userData),
      onApplied: () => setUser(userData),
    })
  }, [])

  const getAccessToken = useCallback(async () => {
    return SecureStore.getItemAsync('access_token')
  }, [])

  const signOut = useCallback(async () => {
    // Same reason as signInWithTokens: a guest mint that is mid-flight must
    // not resurrect a session the user just ended.
    queueRef.current.bumpEpoch()
    await runExclusive(async () => {
      await SecureStore.deleteItemAsync('access_token')
      await SecureStore.deleteItemAsync('refresh_token')
      await SecureStore.deleteItemAsync('user')
      // Without this the Google SDK keeps the previously-selected account
      // cached and the next "Continue with Google" silently signs the
      // same user back in — no account picker, no way to switch users.
      // Wrap in try/catch because signOut() throws if the user wasn't
      // signed in via Google in the first place (email-only / Apple paths).
      try { await googleSigninModule?.GoogleSignin?.signOut?.() } catch {}
      // Per-user AsyncStorage caches must not leak into the next session —
      // otherwise a fresh sign-in opens books on the previous user's last
      // page. Server progress trumps local on the next flush, but the brief window is
      // visible and confusing.
      clearAllLocalProgress().catch(() => {})
      clearReaderCache().catch(() => {})
      setUser(null)
    })
  }, [runExclusive])

  // React to terminal auth failures from the API layer. The emitter is
  // latched in `api.ts` so we only see one event per expired session,
  // even if 20 hooks fired 20 concurrent 401s.
  useEffect(() => {
    const unsubscribe = onAuthFailure(() => {
      // Only flip UI state if we still think we're logged in —
      // otherwise the listener is a no-op (e.g. user already signed out
      // manually, or this fired during a background refresh cycle).
      if (userRef.current !== null) {
        // The API layer has already deleted the tokens. Bump the epoch so a
        // guest mint in flight discards instead of writing a `user` row whose
        // tokens are gone.
        queueRef.current.bumpEpoch()
        void runExclusive(async () => { await SecureStore.deleteItemAsync('user') }).catch(() => {})
        // Same reasoning as in signOut: avoid Google SDK silently
        // re-authing the same user on the next attempt.
        Promise.resolve()
          .then(() => googleSigninModule?.GoogleSignin?.signOut?.())
          .catch(() => {})
        clearAllLocalProgress().catch(() => {})
        clearReaderCache().catch(() => {})
        setUser(null)
      }
    })
    return unsubscribe
  }, [runExclusive])

  // -------------------------------------------------------------------------
  // Guest minting
  // -------------------------------------------------------------------------

  const waitForSession = useCallback(async () => {
    if (!isLoadingRef.current) return
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      sessionReadyRef.current!.promise,
      // A hard ceiling so this can never hang. Only reachable if the native
      // keychain read never returns, in which case the answer is "we still do
      // not know" and the caller must decide without us.
      new Promise<void>((r) => { timer = setTimeout(r, SESSION_BOOTSTRAP_TIMEOUT_MS) }),
    ])
    if (timer) clearTimeout(timer)
  }, [])

  /**
   * Single-flight `POST /auth/guest`. Concurrent callers — the reader gate and
   * a word tap in the same frame, or two route wrappers during a redirect —
   * share ONE request. Two requests would mean two server rows, one of which
   * nobody can ever reach again, plus a wasted mint against a rate limit of a
   * few per window.
   */
  const guestFlightRef = useRef(createSingleFlight<EnsureSessionResult>())

  const createGuestOnce = useCallback(async (): Promise<EnsureSessionResult> => {
    // Captured BEFORE the first await, per the epoch contract.
    const epochAtStart = queueRef.current.epoch
    let res: Awaited<ReturnType<typeof authApi.createGuestSession>>
    try {
      res = await authApi.createGuestSession()
    } catch (error) {
      // Surfaced, not swallowed. `createGuestSession` also throws on a 200
      // whose body carries no accessToken, so this covers the token-less
      // "you are already authenticated" branch of the endpoint.
      return { status: 'failed', error }
    }
    return runExclusive(async (): Promise<EnsureSessionResult> => {
      const decision = decideApplyGuest({
        epochAtStart,
        epochNow: queueRef.current.epoch,
        currentUser: userRef.current,
      })
      // All three writes and the setUser, or none of them. The queue
      // guarantees no sign-in can slip between them after this point.
      if (decision.action === 'discard') return { status: 'discarded', reason: decision.reason }
      try {
        await SecureStore.setItemAsync('access_token', res.accessToken)
        await SecureStore.setItemAsync('refresh_token', res.refreshToken)
        await SecureStore.setItemAsync('user', JSON.stringify(res.user))
      } catch (error) {
        // A keychain that refuses to write is indistinguishable, from the
        // caller's side, from a mint that never came back: either way there is
        // no durable session. Reported, not thrown — ensureSession's contract
        // is that it always resolves.
        return { status: 'failed', error }
      }
      // A guest sign-in is a sign-in: without this a latch left set by the
      // previous session's terminal failure stays set, and the NEXT expiry
      // never reaches the UI.
      resetAuthFailureLatch()
      setUser(res.user)
      return { status: 'minted' }
    })
  }, [runExclusive])

  const ensureSession = useCallback(async (): Promise<EnsureSessionResult> => {
    // Never mint over a bootstrap in progress: `user` is null then for a
    // returning user too, and minting on that null orphans a row and burns a
    // rate-limit slot on someone who already has an account.
    await waitForSession()
    const decision = decideMint({ isLoading: isLoadingRef.current, user: userRef.current })
    if (decision.action === 'skip') {
      return decision.reason === 'bootstrapping'
        ? { status: 'skipped', reason: 'bootstrapping' }
        : { status: 'existing', isGuest: userRef.current?.isGuest === true }
    }
    return guestFlightRef.current.run(createGuestOnce)
  }, [waitForSession, createGuestOnce])

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: user !== null,
        isLoading,
        signInWithTokens,
        updateUser,
        getAccessToken,
        signOut,
        ensureSession,
        waitForSession,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}
