import { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react'
import {
  User, UpdateProfilePayload, getCurrentUser, loginWithGoogle, logout as logoutApi, refreshToken,
  loginWithEmail as loginWithEmailApi, registerWithEmail as registerWithEmailApi,
  updateProfile as updateProfileApi, uploadAvatar as uploadAvatarApi, deleteAvatar as deleteAvatarApi,
  deleteAccount as deleteAccountApi,
  createGuestSession as createGuestSessionApi,
} from '../api/auth'
import type { GuestMergeSkipReason } from '@textstack/shared'
import { authToastFor } from '../lib/authToast'
import { flushLocalProgress } from '../lib/progressSync'
import { trackLogin, trackSignUp } from '../lib/analytics'

interface AuthContextValue {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
  isGuest: boolean
  googleReady: boolean
  showAuthModal: boolean
  openAuthModal: () => void
  closeAuthModal: () => void
  loginWithEmail: (email: string, password: string) => Promise<void>
  registerWithEmail: (email: string, password: string, name?: string) => Promise<void>
  /** Resolves once the initial session bootstrap has settled (auth, refresh, or guest). Never rejects. */
  waitForSession: () => Promise<void>
  ensureSession: () => Promise<void>
  logout: () => Promise<void>
  updateProfile: (payload: UpdateProfilePayload) => Promise<void>
  updateAvatar: (file: File) => Promise<void>
  deleteAvatar: () => Promise<void>
  /** Permanently deletes the account + all data, then clears the session locally. Rejects on error (caller stays signed in). */
  deleteAccount: () => Promise<void>
  /** Set to true after a successful register/login. Consumer shows toast then calls dismissAuthSuccessToast. */
  authSuccessToast: boolean
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
  openAuthModal: () => {},
  closeAuthModal: () => {},
  loginWithEmail: async () => {},
  registerWithEmail: async () => {},
  waitForSession: async () => {},
  ensureSession: async () => {},
  logout: async () => {},
  updateProfile: async () => {},
  updateAvatar: async () => {},
  deleteAvatar: async () => {},
  deleteAccount: async () => {},
  authSuccessToast: false,
  dismissAuthSuccessToast: () => {},
  guestMergeSkipped: null,
  dismissGuestMergeSkipped: () => {},
})

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID

/** Hard ceiling on how long waitForSession waits for bootstrap to settle. */
const SESSION_BOOTSTRAP_TIMEOUT_MS = 15_000

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [googleReady, setGoogleReady] = useState(false)
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [authSuccessToast, setAuthSuccessToast] = useState(false)
  const dismissAuthSuccessToast = useCallback(() => setAuthSuccessToast(false), [])
  const [guestMergeSkipped, setGuestMergeSkipped] = useState<GuestMergeSkipReason | null>(null)
  const dismissGuestMergeSkipped = useCallback(() => setGuestMergeSkipped(null), [])

  // Google callback - stable ref to avoid stale closures
  const handleGoogleCallback = useCallback(async (response: google.accounts.id.CredentialResponse) => {
    try {
      setIsLoading(true)
      const authResponse = await loginWithGoogle(response.credential)
      // Capture prev before setUser — if a real user logs in again (re-auth), no toast.
      setUser(prev => {
        const toast = authToastFor(prev === null || prev.isGuest, authResponse.guestMergeSkipped)
        if (toast === 'merge-skipped') setGuestMergeSkipped(authResponse.guestMergeSkipped!)
        else if (toast === 'success') setAuthSuccessToast(true)
        return authResponse.user
      })
      setShowAuthModal(false)
      // Distinguish new signups from returning logins via createdAt recency.
      // Backend doesn't surface an isNew flag yet; 60s window is a safe heuristic.
      const createdAtMs = Date.parse(authResponse.user.createdAt)
      const isFreshAccount = Number.isFinite(createdAtMs) && Date.now() - createdAtMs < 60_000
      if (isFreshAccount) trackSignUp('google')
      else trackLogin('google')
      // Fire-and-forget: flush any anonymous localStorage progress to server.
      void flushLocalProgress().catch(() => {})
    } catch (error) {
      console.error('Login failed:', error)
    } finally {
      setIsLoading(false)
    }
  }, [])

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
    const promise = createGuestSessionApi()
      .then((res) => {
        // I3: no-downgrade — не перетираем не-guest юзера.
        // Race: login мог завершиться пока guest-промис был in-flight.
        setUser(prev => (prev && !prev.isGuest ? prev : res.user))
        return res.user
      })
      .catch(() => {
        // Падение guest-create не должно трогать существующего юзера.
        setUser(prev => (prev && !prev.isGuest ? prev : null))
        return null
      })
      .finally(() => { inFlightGuestRef.current = null })
    inFlightGuestRef.current = promise
    return promise
  }, [])

  // StrictMode fires effects twice in dev; this ref dedupes the bootstrap so we never hit /auth/guest twice.
  const bootstrapStartedRef = useRef(false)

  // I1: Bootstrap = read-only session probe. Проверяем существующую сессию, но
  // НЕ создаём guest. Guest создаётся demand-driven (ensureSession → первый tap
  // слова в reader или upload книги). Homepage/login/каталог не триггерят /auth/guest.
  useEffect(() => {
    if (bootstrapStartedRef.current) return
    bootstrapStartedRef.current = true

    const sessionReady = sessionReadyRef.current!
    let timeoutId: ReturnType<typeof setTimeout> | null = null
    const timeoutPromise = new Promise<void>((r) => {
      timeoutId = setTimeout(r, SESSION_BOOTSTRAP_TIMEOUT_MS)
    })

    const bootstrap = async () => {
      // On bootstrap the user didn't just authenticate — they restored a session. So we only
      // surface the "progress kept" toast if flushLocalProgress actually recovered something
      // (i.e. they read anonymously in a prior tab before signing in, and that progress was
      // sitting in localStorage waiting to be dispatched).
      const flushIfReal = async (u: User) => {
        if (u.isGuest) return
        try {
          const n = await flushLocalProgress()
          if (n > 0) setAuthSuccessToast(true)
        } catch { /* keep keys for next attempt */ }
      }
      try {
        const response = await getCurrentUser()
        setUser(response.user)
        void flushIfReal(response.user)
      } catch {
        try {
          const response = await refreshToken()
          setUser(response.user)
          void flushIfReal(response.user)
        } catch {
          // I1: bootstrap read-only. user остаётся null; фичи сами зовут ensureSession().
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
      }
    })()
  }, [])

  // Load and initialize Google Sign-In in single effect
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || googleReady) return

    const initGoogle = async () => {
      // Load script if not present
      if (!document.getElementById('google-signin-script')) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement('script')
          script.id = 'google-signin-script'
          script.src = 'https://accounts.google.com/gsi/client'
          script.async = true
          script.defer = true
          script.onload = () => resolve()
          script.onerror = () => reject(new Error('Failed to load Google Sign-In'))
          document.head.appendChild(script)
        })
      }

      // Initialize Google Sign-In
      if (typeof google !== 'undefined' && google.accounts?.id) {
        google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: handleGoogleCallback,
          auto_select: false,
          cancel_on_tap_outside: true,
        })
        setGoogleReady(true)
      }
    }

    initGoogle().catch(err => console.error('[Auth] Failed to init Google:', err))
  }, [handleGoogleCallback, googleReady])

  const openAuthModal = useCallback(() => setShowAuthModal(true), [])
  const closeAuthModal = useCallback(() => setShowAuthModal(false), [])

  const authenticateAndClose = useCallback(async (
    apiCall: () => Promise<{ user: User; guestMergeSkipped?: GuestMergeSkipReason | null }>,
    kind: 'login' | 'sign_up',
  ) => {
    const response = await apiCall()
    // Only show the "progress kept" reassurance when user actually transitioned from
    // anonymous/guest to real. A returning real user re-authenticating had nothing at risk.
    setUser(prev => {
      const toast = authToastFor(prev === null || prev.isGuest, response.guestMergeSkipped)
      if (toast === 'merge-skipped') setGuestMergeSkipped(response.guestMergeSkipped!)
      else if (toast === 'success') setAuthSuccessToast(true)
      return response.user
    })
    setShowAuthModal(false)
    if (kind === 'sign_up') trackSignUp('email')
    else trackLogin('email')
    // Fire-and-forget: flush any anonymous localStorage progress to server (server LWW is safe).
    void flushLocalProgress().catch(() => {})
  }, [])

  const loginWithEmail = useCallback(
    (email: string, password: string) => authenticateAndClose(() => loginWithEmailApi(email, password), 'login'),
    [authenticateAndClose],
  )

  const registerWithEmail = useCallback(
    (email: string, password: string, name?: string) => authenticateAndClose(() => registerWithEmailApi(email, password, name), 'sign_up'),
    [authenticateAndClose],
  )

  const updateProfile = useCallback(async (payload: UpdateProfilePayload) => {
    const response = await updateProfileApi(payload)
    setUser(response.user)
  }, [])

  const updateAvatar = useCallback(async (file: File) => {
    const response = await uploadAvatarApi(file)
    setUser(response.user)
  }, [])

  const deleteAvatar = useCallback(async () => {
    await deleteAvatarApi()
    setUser(prev => prev ? { ...prev, picture: null } : null)
  }, [])

  // Permanently deletes the account server-side, then clears the local session.
  // Mirrors logout's anonymous-after sign-out: no guest re-create here. Rethrows
  // on failure so the caller keeps the user signed in and surfaces an error.
  const deleteAccount = useCallback(async () => {
    await deleteAccountApi()
    if (typeof google !== 'undefined') {
      google.accounts.id.disableAutoSelect()
    }
    setUser(null)
  }, [])

  // Public: create a guest session if not authenticated. Routes through the single-flight
  // helper so concurrent callers (e.g. HeroSection upload + bootstrap) share one network call.
  const ensureSession = useCallback(async () => {
    if (user) return
    await createGuestOnce()
  }, [user, createGuestOnce])

  const logout = useCallback(async () => {
    try {
      await logoutApi()
      if (typeof google !== 'undefined') {
        google.accounts.id.disableAutoSelect()
      }
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
