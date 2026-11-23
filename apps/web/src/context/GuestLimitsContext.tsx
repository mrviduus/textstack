import { createContext, useContext, useEffect, ReactNode } from 'react'

// Guests are NOT rate-limited by the client. `POST /auth/guest` is minted on
// demand and the account is promoted in place on register, so there is nothing
// to meter — the marketing copy in locales/en.json promises exactly that.
// The one number left is a UX threshold, not a limit: how many words a reader
// saves locally before we mint the session behind them.
const COMMITMENT_THRESHOLD = 3

// Legacy key — cleaned up once on mount. Guest state no longer persisted (cookie session is SoT).
const LEGACY_STORAGE_KEY = 'guest.state.v1'

interface GuestLimitsContextValue {
  commitmentThreshold: number
}

const value: GuestLimitsContextValue = { commitmentThreshold: COMMITMENT_THRESHOLD }

const GuestLimitsContext = createContext<GuestLimitsContextValue>(value)

export function GuestLimitsProvider({ children }: { children: ReactNode }) {
  // One-time cleanup of legacy localStorage key.
  useEffect(() => {
    try { localStorage.removeItem(LEGACY_STORAGE_KEY) } catch {}
  }, [])

  return <GuestLimitsContext.Provider value={value}>{children}</GuestLimitsContext.Provider>
}

export function useGuestLimits() {
  return useContext(GuestLimitsContext)
}
