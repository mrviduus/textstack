import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StrictMode } from 'react'
import { act, waitFor, renderHook } from '@testing-library/react'

// --- Mocks: the entire auth API surface. ---
const getCurrentUserMock = vi.fn()
const refreshTokenMock = vi.fn()
const createGuestSessionMock = vi.fn()
const logoutMock = vi.fn()
const loginWithEmailMock = vi.fn()

vi.mock('../../api/auth', () => ({
  getCurrentUser: () => getCurrentUserMock(),
  refreshToken: () => refreshTokenMock(),
  createGuestSession: () => createGuestSessionMock(),
  logout: () => logoutMock(),
  loginWithGoogle: vi.fn(),
  loginWithEmail: (...args: unknown[]) => loginWithEmailMock(...args),
  registerWithEmail: vi.fn(),
  updateProfile: vi.fn(),
  uploadAvatar: vi.fn(),
  deleteAvatar: vi.fn(),
}))

// Import AFTER mocks so the module picks them up.
import { AuthProvider, useAuth } from '../AuthContext'

const guestUser = { id: 'g-1', email: '', name: null, picture: null, isGuest: true } as const

function wrapperStrict({ children }: { children: React.ReactNode }) {
  return <StrictMode><AuthProvider>{children}</AuthProvider></StrictMode>
}

function wrapperPlain({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>
}

describe('AuthContext bootstrap', () => {
  beforeEach(() => {
    getCurrentUserMock.mockReset()
    refreshTokenMock.mockReset()
    createGuestSessionMock.mockReset()
    logoutMock.mockReset()
    loginWithEmailMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // I1: bootstrap is a read-only session probe — never creates a guest.
  it('bootstrap is read-only — no POST /auth/guest when unauthenticated', async () => {
    getCurrentUserMock.mockRejectedValue(new Error('401'))
    refreshTokenMock.mockRejectedValue(new Error('401'))
    createGuestSessionMock.mockResolvedValue({ user: guestUser })

    const { result } = renderHook(() => useAuth(), { wrapper: wrapperStrict })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    expect(createGuestSessionMock).not.toHaveBeenCalled()
    expect(result.current.isAuthenticated).toBe(false)
    expect(result.current.user).toBeNull()
  })

  // I2: guest is created on-demand when a feature needs a persistence session.
  it('ensureSession creates guest on demand after read-only bootstrap', async () => {
    getCurrentUserMock.mockRejectedValue(new Error('401'))
    refreshTokenMock.mockRejectedValue(new Error('401'))
    createGuestSessionMock.mockResolvedValue({ user: guestUser })

    const { result } = renderHook(() => useAuth(), { wrapper: wrapperPlain })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(createGuestSessionMock).not.toHaveBeenCalled()

    await act(async () => { await result.current.ensureSession() })

    expect(createGuestSessionMock).toHaveBeenCalledTimes(1)
    expect(result.current.isAuthenticated).toBe(true)
    expect(result.current.isGuest).toBe(true)
  })

  // I3: late-arriving guest response must not overwrite a real user who logged in.
  it('in-flight guest create does not stomp authenticated user (I3)', async () => {
    getCurrentUserMock.mockRejectedValue(new Error('401'))
    refreshTokenMock.mockRejectedValue(new Error('401'))
    let resolveGuest: (v: { user: typeof guestUser }) => void = () => {}
    createGuestSessionMock.mockImplementation(
      () => new Promise((r) => { resolveGuest = r })
    )

    const authedUser = { id: 'u-real', email: 'a@b.c', name: null, picture: null, isGuest: false }
    loginWithEmailMock.mockResolvedValue({ user: authedUser })

    const { result } = renderHook(() => useAuth(), { wrapper: wrapperPlain })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // User taps a word → reader flow fires ensureSession → guest in-flight.
    let ensureP!: Promise<boolean>
    act(() => { ensureP = result.current.ensureSession() })

    // Meanwhile user hits login on another tab/flow.
    await act(async () => { await result.current.loginWithEmail('a@b.c', 'pw') })
    expect(result.current.user?.id).toBe('u-real')
    expect(result.current.isGuest).toBe(false)

    // Guest response arrives LATE. MUST NOT overwrite the real user.
    await act(async () => {
      resolveGuest({ user: guestUser })
      await ensureP
    })
    expect(result.current.user?.id).toBe('u-real')
    expect(result.current.isGuest).toBe(false)
  })

  it('waitForSession resolves after normal bootstrap', async () => {
    getCurrentUserMock.mockResolvedValue({
      user: { id: 'u-1', email: 'a@b.c', name: null, picture: null, isGuest: false },
    })

    const { result } = renderHook(() => useAuth(), { wrapper: wrapperPlain })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    await expect(result.current.waitForSession()).resolves.toBeUndefined()
    expect(createGuestSessionMock).not.toHaveBeenCalled()
  })

  it('waitForSession cannot hang forever — resolves via timeout if bootstrap stalls', async () => {
    vi.useFakeTimers()
    // Make every attempt pend indefinitely.
    getCurrentUserMock.mockReturnValue(new Promise(() => {}))
    refreshTokenMock.mockReturnValue(new Promise(() => {}))
    createGuestSessionMock.mockReturnValue(new Promise(() => {}))

    const { result } = renderHook(() => useAuth(), { wrapper: wrapperPlain })

    // waitForSession should resolve after the timeout even though bootstrap is stuck.
    const waited = result.current.waitForSession()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(16_000)
    })

    await expect(waited).resolves.toBeUndefined()
  })

  it('logout leaves user anonymous (no auto-guest re-create)', async () => {
    const authedUser = { id: 'u-2', email: 'x@y.z', name: null, picture: null, isGuest: false, createdAt: '2026-01-01T00:00:00Z' }
    getCurrentUserMock.mockResolvedValue({ user: authedUser })
    logoutMock.mockResolvedValue(undefined)
    createGuestSessionMock.mockResolvedValue({ user: guestUser })

    const { result } = renderHook(() => useAuth(), { wrapper: wrapperPlain })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(createGuestSessionMock).not.toHaveBeenCalled()

    await act(async () => { await result.current.logout() })

    expect(logoutMock).toHaveBeenCalledTimes(1)
    // Phase 1+2: bootstrap is read-only and guest is demand-driven.
    // Sign-out must NOT immediately spawn a new guest — otherwise it's a no-op visually.
    expect(createGuestSessionMock).not.toHaveBeenCalled()
    expect(result.current.isAuthenticated).toBe(false)
    expect(result.current.isGuest).toBe(false)
    expect(result.current.user).toBeNull()
  })

  it('concurrent ensureSession + logout dedupe into one guest create', async () => {
    // Bootstrap completes unauthenticated (I1: no auto-guest).
    getCurrentUserMock.mockRejectedValue(new Error('401'))
    refreshTokenMock.mockRejectedValue(new Error('401'))
    let resolveGuest: (v: { user: typeof guestUser }) => void = () => {}
    createGuestSessionMock.mockImplementation(
      () => new Promise((r) => { resolveGuest = r })
    )

    const { result } = renderHook(() => useAuth(), { wrapper: wrapperPlain })
    await waitFor(() => expect(result.current.isLoading).toBe(false))

    // Fire ensureSession (simulates word-tap) and logout concurrently.
    // Phase 1+2: logout no longer calls createGuestOnce → only ensureSession triggers guest-create.
    logoutMock.mockResolvedValue(undefined)

    let ensureP!: Promise<boolean>
    act(() => { ensureP = result.current.ensureSession() })
    const logoutP = result.current.logout()

    await act(async () => {
      resolveGuest({ user: guestUser })
      await ensureP
      await logoutP
    })

    // Exactly one guest-create (from ensureSession). logout is a no-op on network side here.
    expect(createGuestSessionMock).toHaveBeenCalledTimes(1)
  })
})

