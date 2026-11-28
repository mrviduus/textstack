import { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode, SyntheticEvent } from 'react'
import type { User, UpdateProfilePayload } from '../api/auth'
import type { GuestMergeSkipReason } from '@textstack/shared'
import { authToastFor, type AuthToast } from '../lib/authToast'
import { trackLogin, trackSignUp } from '../lib/analytics'
import type { MergeMap } from '../lib/mergeMap'
import { platform } from '../platform'

export type AuthModalView = 'login' | 'register'

/** Which reassurance toast is pending after sign-in (`merge-skipped` lives in `guestMergeSkipped`). */
export type AuthSuccessToast = Exclude<AuthToast, 'merge-skipped' | null> | null

interface AuthContextValue {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
  isGuest: boolean
  googleReady: boolean
  showAuthModal: boolean
  /** Tab the auth modal opens on. */
  authModalView: AuthModalView
  /** Opens the auth modal. Also used directly as an onClick handler, so a click event means 'login'. */
  openAuthModal: (view?: AuthModalView | SyntheticEvent) => void
  closeAuthModal: () => void
  loginWithEmail: (email: string, password: string) => Promise<void>
  registerWithEmail: (email: string, password: string, name?: string) => Promise<void>
  /** Resolves once the initial session bootstrap has settled (auth, refresh, or guest). Never rejects. */
  waitForSession: () => Promise<void>
  /** Makes a guest session when there is no user. Resolves to whether a user is there now. Never rejects. */
  ensureSession: () => Promise<boolean>
  logout: () => Promise<void>
  updateProfile: (payload: UpdateProfilePayload) => Promise<void>
  updateAvatar: (file: File) => Promise<void>
  deleteAvatar: () => Promise<void>
  /** Permanently deletes the account + all data, then clears the session locally. Rejects on error (caller stays signed in). */
  deleteAccount: () => Promise<void>
  /** Set after a successful register/login (see authToastFor). Consumer shows toast then calls dismissAuthSuccessToast. */
  authSuccessToast: AuthSuccessToast
  dismissAuthSuccessToast: () => void
  /**
   * Set when the sign-in did NOT bring the reader's pre-sign-in work across.
   *
   * <p>Mutually exclusive with {@link authSuccessToast} on purpose: that one says "your progress is
   * saved", which is precisely the sentence that must not be shown to someone whose progress was
   * left behind. The server has reported this since guest sessions shipped; no client read it, so
   * the reassurance was shown anyway.</p>
   */
  guestMergeSkipped: GuestMergeSkipReason | null
  dismissGuestMergeSkipped: () => void
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  isGuest: false,
  googleReady: false,
  showAuthModal: false,
  authModalView: 'login',
  openAuthModal: () => {},
  closeAuthModal: () => {},
  loginWithEmail: async () => {},
  registerWithEmail: async () => {},
  waitForSession: async () => {},
  ensureSession: async () => false,
  logout: async () => {},
  updateProfile: async () => {},
  updateAvatar: async () => {},
  deleteAvatar: async () => {},
  deleteAccount: async () => {},
  authSuccessToast: null,
  dismissAuthSuccessToast: () => {},
  guestMergeSkipped: null,
  dismissGuestMergeSkipped: () => {},
})

/** Hard ceiling on how long waitForSession waits for bootstrap to settle. */
const SESSION_BOOTSTRAP_TIMEOUT_MS = 15_000

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [googleReady, setGoogleReady] = useState(false)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [authModalView, setAuthModalView] = useState<AuthModalView>('login')
  const [authSuccessToast, setAuthSuccessToast] = useState<AuthSuccessToast>(null)
  const dismissAuthSuccessToast = useCallback(() => setAuthSuccessToast(null), [])
  const [guestMergeSkipped, setGuestMergeSkipped] = useState<GuestMergeSkipReason | null>(null)
  const dismissGuestMergeSkipped = useCallback(() => setGuestMergeSkipped(null), [])
  // The V2 probe needs a session (PathGates answers 401 without one): started wherever a user is
  // set, before anything that calls the API next. API calls await the same probe, so none races it.
  const probeSync = useCallback(() => platform.session.userSet(), [])

  // The V2 cache is one account's: an account change (sign-out, another sign-in) empties it.
  const userId = user?.id ?? null
  const cachedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (cachedForRef.current !== null && cachedForRef.current !== userId) platform.session.accountChanged()
    cachedForRef.current = userId
  }, [userId])

  // Google callback - stable ref to avoid stale closures
  const handleGoogleCallback = useCallback(async (idToken: string) => {
    try {
      setIsLoading(true)
      const authResponse = await platform.account.loginWithGoogle(idToken)
      // Capture prev before setUser — if a real user logs in again (re-auth), no toast.
      setUser(prev => {
        const toast = authToastFor(prev, authResponse.guestMergeSkipped)
        if (toast === 'merge-skipped') setGuestMergeSkipped(authResponse.guestMergeSkipped!)
        else setAuthSuccessToast(toast)
        return authResponse.user
      })
      probeSync()
      setShowAuthModal(false)
      // Distinguish new signups from returning logins via createdAt recency.
      // Backend doesn't surface an isNew flag yet; 60s window is a safe heuristic.
      const createdAtMs = Date.parse(authResponse.user.createdAt)
      const isFreshAccount = Number.isFinite(createdAtMs) && Date.now() - createdAtMs < 60_000
      if (isFreshAccount) trackSignUp('google')
      else trackLogin('google')
      // Fire-and-forget: flush any anonymous localStorage progress + pending highlights to server,
      // after a V2 merge re-keyed them.
      void platform.session.signedIn(authResponse.merge)
    } catch (error) {
      console.error('Login failed:', error)
    } finally {
      setIsLoading(false)
    }
  }, [probeSync])

  // Session-ready gate: resolves once the initial auth/refresh/guest-create attempt has settled.
  // Consumers (e.g. reader vocab save) await this before deciding to hit auth-gated APIs.
  const sessionReadyRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null)
  if (!sessionReadyRef.current) {
    let resolveFn: () => void = () => {}
    const promise = new Promise<void>((r) => { resolveFn = r })
    sessionReadyRef.current = { promise, resolve: resolveFn }
  }
  // waitForSession races the bootstrap promise with a hard timeout so it can never hang.
  const waitForSession = useCallback(async () => {
    await Promise.race([
      sessionReadyRef.current!.promise,
      new Promise<void>((r) => setTimeout(r, SESSION_BOOTSTRAP_TIMEOUT_MS)),
    ])
  }, [])

  // Single-flight guard for POST /auth/guest. Shared by ensureSession and logout
  // so concurrent callers (StrictMode double-invoke, logout race, HeroSection upload) dedupe into one call.
  const inFlightGuestRef = useRef<Promise<User | null> | null>(null)
  const createGuestOnce = useCallback(async (): Promise<User | null> => {
    if (inFlightGuestRef.current) return inFlightGuestRef.current
    const promise = platform.account.createGuestSession()
      .then((res) => {
        // I3: no downgrade. A real (not guest) user is never replaced by the guest.
        // Race: a sign-in can finish while the guest call is in flight.
        setUser(prev => (prev && !prev.isGuest ? prev : res.user))
        probeSync()
        return res.user
      })
      .catch(() => {
        // A failed guest call never changes the user that is there.
        setUser(prev => (prev && !prev.isGuest ? prev : null))
        return null
      })
      .finally(() => { inFlightGuestRef.current = null })
    inFlightGuestRef.current = promise
    return promise
  }, [probeSync])

  // StrictMode fires effects twice in dev; this ref dedupes the bootstrap so we never hit /auth/guest twice.
  const bootstrapStartedRef = useRef(false)

  // I1: the start-up check only reads the session. It looks for a session and does NOT make a guest.
  // A guest is made on demand (ensureSession: the first word tap in the reader, or a book upload).
  // The home page and the sign-in page never call /auth/guest.
  useEffect(() => {
    if (bootstrapStartedRef.current) return
    bootstrapStartedRef.current = true

    const sessionReady = sessionReadyRef.current!
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<void>((r) => {
      timeoutId = setTimeout(r, SESSION_BOOTSTRAP_TIMEOUT_MS)
    })

    const bootstrap = async () => {
      // A restored session: replay the highlights made without one.
      const flushIfReal = (u: User) => {
        if (!u.isGuest) void platform.session.restored()
      }
      try {
        const response = await platform.account.getCurrentUser()
        setUser(response.user)
        probeSync()
        flushIfReal(response.user)
      } catch {
        try {
          const response = await platform.account.refreshToken()
          setUser(response.user)
          probeSync()
          flushIfReal(response.user)
        } catch {
          // I1: the start-up check only reads. The user stays null; a feature calls ensureSession() itself.
        }
      }
    }

    ;(async () => {
      try {
        await Promise.race([bootstrap(), timeoutPromise])
      } finally {
        if (timeoutId) clearTimeout(timeoutId)
        setIsLoading(false)
        sessionReady.resolve()
        platform.session.settled()
      }
    })()
  }, [])

  // Load and set up the platform's Google sign-in once (web: Google Identity Services).
  useEffect(() => {
    if (googleReady) return
    platform.google.init((idToken) => { void handleGoogleCallback(idToken) })
      .then((ready) => { if (ready) setGoogleReady(true) })
      .catch(err => console.error('[Auth] Failed to init Google:', err))
  }, [handleGoogleCallback, googleReady])

  const openAuthModal = useCallback((view?: AuthModalView | SyntheticEvent) => {
    setAuthModalView(view === 'register' ? 'register' : 'login')
    setShowAuthModal(true)
  }, [])
  const closeAuthModal = useCallback(() => setShowAuthModal(false), [])

  const authenticateAndClose = useCallback(async (
    apiCall: () => Promise<{ user: User; guestMergeSkipped?: GuestMergeSkipReason | null; merge?: MergeMap }>,
    kind: 'login' | 'sign_up',
  ) => {
    const response = await apiCall()
    // Only show the "progress kept" reassurance when user actually transitioned from
    // anonymous/guest to real. A returning real user re-authenticating had nothing at risk.
    setUser(prev => {
      const toast = authToastFor(prev, response.guestMergeSkipped)
      if (toast === 'merge-skipped') setGuestMergeSkipped(response.guestMergeSkipped!)
      else setAuthSuccessToast(toast)
      return response.user
    })
    probeSync()
    setShowAuthModal(false)
    if (kind === 'sign_up') trackSignUp('email')
    else trackLogin('email')
    // Fire-and-forget: flush any anonymous localStorage progress to server (server LWW is safe),
    // and replay highlights made without a session, across every book — after a V2 merge re-keyed them.
    void platform.session.signedIn(response.merge)
  }, [probeSync])

  const loginWithEmail = useCallback(
    (email: string, password: string) => authenticateAndClose(() => platform.account.loginWithEmail(email, password), 'login'),
    [authenticateAndClose],
  )

  const registerWithEmail = useCallback(
    (email: string, password: string, name?: string) => authenticateAndClose(() => platform.account.registerWithEmail(email, password, name), 'sign_up'),
    [authenticateAndClose],
  )

  const updateProfile = useCallback(async (payload: UpdateProfilePayload) => {
    const response = await platform.account.updateProfile(payload)
    setUser(response.user)
  }, [])

  const updateAvatar = useCallback(async (file: File) => {
    const response = await platform.account.uploadAvatar(file)
    setUser(response.user)
  }, [])

  const deleteAvatar = useCallback(async () => {
    await platform.account.deleteAvatar()
    setUser(prev => prev ? { ...prev, picture: null } : null)
  }, [])

  // Permanently deletes the account server-side, then clears the local session.
  // Mirrors logout's anonymous-after sign-out: no guest re-create here. Rethrows
  // on failure so the caller keeps the user signed in and surfaces an error.
  const deleteAccount = useCallback(async () => {
    await platform.account.deleteAccount()
    platform.google.signOut()
    setUser(null)
  }, [])

  // Public: create a guest session if not authenticated. Routes through the single-flight
  // helper so concurrent callers (e.g. HeroSection upload + bootstrap) share one network call.
  const ensureSession = useCallback(async () => {
    if (user) return true
    return (await createGuestOnce()) !== null
  }, [user, createGuestOnce])

  const logout = useCallback(async () => {
    try {
      await platform.account.logout()
      platform.google.signOut()
      // Sign out = user becomes anonymous. Phase 1 bootstrap is read-only and
      // guest creation is demand-driven (ensureSession on commitment signal),
      // so we don't re-create a guest here — that would make "Sign out" a no-op
      // from the user's perspective.
      setUser(null)
    } catch (error) {
      console.error('Logout failed:', error)
    }
  }, [])

  return (
    <AuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        isGuest: user?.isGuest ?? false,
        googleReady,
        showAuthModal,
        authModalView,
        openAuthModal,
        closeAuthModal,
        loginWithEmail,
        registerWithEmail,
        waitForSession,
        ensureSession,
        logout,
        updateProfile,
        updateAvatar,
        deleteAvatar,
        deleteAccount,
        authSuccessToast,
        dismissAuthSuccessToast,
        guestMergeSkipped,
        dismissGuestMergeSkipped,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}

