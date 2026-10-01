import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from 'react'
import { LANGUAGES } from '@textstack/shared'
import { useAuth } from './AuthContext'

const STORAGE_KEY = 'textstack_native_language'
const CONFIRMED_KEY = 'textstack_native_language_confirmed'

function isSupported(code: string): boolean {
  return LANGUAGES.some((l) => l.code === code)
}

function detectDefault(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored && isSupported(stored)) return stored
  } catch {}
  const browser = navigator.language?.split('-')[0]
  if (browser && isSupported(browser)) return browser
  try {
    for (const lang of navigator.languages || []) {
      const code = lang.split('-')[0]
      if (isSupported(code)) return code
    }
  } catch {}
  return 'en'
}

interface NativeLanguageContextValue {
  nativeLanguage: string
  setNativeLanguage: (code: string) => void
  hasConfirmedLanguage: boolean
  /**
   * Mark the onboarding choice complete without changing the native language.
   * Used when the user makes a related valid selection (e.g. picks their
   * learning target in the header switcher) — we treat that as sufficient
   * intent to stop nagging them with the pulse, even though their native
   * side keeps the detected default.
   */
  markConfirmed: () => void
}

const NativeLanguageContext = createContext<NativeLanguageContextValue>({
  nativeLanguage: 'en',
  setNativeLanguage: () => {},
  hasConfirmedLanguage: false,
  markConfirmed: () => {},
})

function detectConfirmed(): boolean {
  try {
    return localStorage.getItem(CONFIRMED_KEY) === '1'
  } catch {
    return false
  }
}

export function NativeLanguageProvider({ children }: { children: ReactNode }) {
  const [nativeLanguage, setNativeLanguageState] = useState(detectDefault)
  const [hasConfirmedLanguage, setHasConfirmedLanguage] = useState(detectConfirmed)
  const { user, updateProfile } = useAuth()

  const setNativeLanguage = useCallback((code: string) => {
    if (!isSupported(code)) return
    setNativeLanguageState(code)
    setHasConfirmedLanguage(true)
    try { localStorage.setItem(STORAGE_KEY, code) } catch {}
    try { localStorage.setItem(CONFIRMED_KEY, '1') } catch {}
    // Logged-in non-guest users: persist to server so the pref follows them across devices.
    // Guests stay localStorage-only until they register (merged below via server-empty branch).
    if (user && !user.isGuest) {
      updateProfile({ nativeLanguage: code }).catch(() => {
        // Keep localStorage as fallback; next load will retry via the sync effect.
      })
    }
  }, [user, updateProfile])

  const markConfirmed = useCallback(() => {
    setHasConfirmedLanguage(true)
    try { localStorage.setItem(CONFIRMED_KEY, '1') } catch {}
  }, [])

  // Track user identity to detect account switches (login→logout→login as different user).
  const prevUserIdRef = useRef(user?.id)

  // Server → local: mirror server's nativeLanguage into state + localStorage on login.
  useEffect(() => {
    // Reset local state on account switch so stale values from the previous
    // user don't leak into the new session (bug: fast login→logout→login race).
    if (prevUserIdRef.current !== user?.id) {
      prevUserIdRef.current = user?.id
      if (!user) {
        setHasConfirmedLanguage(false)
        setNativeLanguageState(detectDefault())
        return
      }
    }
    if (!user || user.isGuest) return
    // Logged-in non-guest → always dismiss the pulse. The user has an account;
    // nagging them to "pick a language" is pointless even if server field is empty.
    if (!hasConfirmedLanguage) {
      setHasConfirmedLanguage(true)
      try { localStorage.setItem(CONFIRMED_KEY, '1') } catch {}
    }
    const serverLang = user.nativeLanguage
    if (!serverLang || !isSupported(serverLang)) return
    if (serverLang !== nativeLanguage) setNativeLanguageState(serverLang)
    try {
      localStorage.setItem(STORAGE_KEY, serverLang)
      localStorage.setItem(CONFIRMED_KEY, '1')
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when the user identity or server value changes
  }, [user?.id, user?.nativeLanguage])

  // Local → server: push confirmed local value to server when server is empty
  // (guest→register merge or imported old user).
  // Read from localStorage directly — React state may not have flushed yet
  // when user.id changes (e.g. guest→register fast path).
  useEffect(() => {
    if (!user || user.isGuest || user.nativeLanguage) return
    try {
      const confirmed = localStorage.getItem(CONFIRMED_KEY) === '1'
      const stored = localStorage.getItem(STORAGE_KEY)
      if (confirmed && stored && isSupported(stored)) {
        updateProfile({ nativeLanguage: stored }).catch(() => {})
      }
    } catch {}
  // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on login, not on every local pick
  }, [user?.id, user?.nativeLanguage])

  return (
    <NativeLanguageContext.Provider value={{ nativeLanguage, setNativeLanguage, hasConfirmedLanguage, markConfirmed }}>
      {children}
    </NativeLanguageContext.Provider>
  )
}

export function useNativeLanguage() {
  return useContext(NativeLanguageContext)
}
