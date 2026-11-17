import { initApi } from '@textstack/shared'
import { refreshToken } from './auth'

export const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080'

// One authFetch for both apps (the shared one). Web runs it in cookie mode: no
// Bearer, `credentials: 'include'`, and a 401 refreshes the cookie (single-flight
// in `refreshToken`) then retries once — `''` means "retry, cookie only".
// Initialised on import so every caller, tests included, gets it before first use.
initApi({
  baseUrl: API_BASE,
  getAccessToken: async () => null,
  onUnauthorized: () => refreshToken().then(() => '', () => null),
  credentials: 'include',
})

export { authFetch, ApiError } from '@textstack/shared'
