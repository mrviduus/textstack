import { createContext, useContext, useEffect, useState, useCallback, ReactNode } from 'react'
import { AdminUser, getAdminMe, adminLogin, adminLogout, adminRefresh } from '../api/auth'

interface AdminAuthContextValue {
  user: AdminUser | null
  isLoading: boolean
  isAuthenticated: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  error: string | null
}

const AdminAuthContext = createContext<AdminAuthContextValue>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  login: async () => {},
  logout: async () => {},
  error: null,
})

export function AdminAuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AdminUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Check current auth status on mount
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await getAdminMe()
        setUser(response.user)
      } catch {
        // Try to refresh token
        try {
          const response = await adminRefresh()
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

  const login = useCallback(async (email: string, password: string) => {
    setError(null)
    setIsLoading(true)
    try {
      const response = await adminLogin(email, password)
      setUser(response.user)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed'
      setError(message)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await adminLogout()
      setUser(null)
    } catch (err) {
      console.error('Logout failed:', err)
    }
  }, [])

  return (
    <AdminAuthContext.Provider
      value={{
        user,
        isLoading,
        isAuthenticated: !!user,
        login,
        logout,
        error,
      }}
    >
      {children}
    </AdminAuthContext.Provider>
  )
}

export function useAdminAuth() {
  return useContext(AdminAuthContext)
}
