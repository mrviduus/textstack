import { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react'
import { User, getCurrentUser, loginWithGoogle, logout as logoutApi, refreshToken } from '../api/auth'

interface AuthContextValue {
  user: User | null
  isLoading: boolean
  isAuthenticated: boolean
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  logout: async () => {},
})

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const initializedRef = useRef(false)

  // Google callback - stable ref to avoid stale closures
  const handleGoogleCallback = useCallback(async (response: google.accounts.id.CredentialResponse) => {
    try {
      setIsLoading(true)
      const authResponse = await loginWithGoogle(response.credential)
      setUser(authResponse.user)
    } catch (error) {
      console.error('Login failed:', error)
    } finally {
      setIsLoading(false)
    }
  }, [])

  // Check current auth status on mount
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await getCurrentUser()
        setUser(response.user)
      } catch {
        // Try to refresh token
        try {
          const response = await refreshToken()
          setUser(response.user)
        } catch {
          setUser(null)
        }
      } finally {
        setIsLoading(false)
      }
    }

    checkAuth()
  }, [])

  // Load and initialize Google Sign-In in single effect
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || initializedRef.current) return

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
        initializedRef.current = true
      }
    }

    initGoogle().catch(err => console.error('[Auth] Failed to init Google:', err))
  }, [handleGoogleCallback])

  const logout = useCallback(async () => {
    try {
      await logoutApi()
      setUser(null)
      if (typeof google !== 'undefined') {
        google.accounts.id.disableAutoSelect()
      }
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
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
