import { initApi } from '@textstack/shared'
import type { Platform } from '.'
import { API_BASE } from '../api/base'
import { refreshToken } from '../api/auth'

// The shared API client in cookie mode: no bearer token. A 401 refreshes the cookie (single-flight in
// `refreshToken`), then the client retries once. `''` means "retry with the cookie only".
initApi({
  baseUrl: API_BASE,
  getAccessToken: async () => null,
  onUnauthorized: () => refreshToken().then(() => '', () => null),
  credentials: 'include',
})

/** The web app: the session is an HttpOnly cookie. */
export const platform: Platform = {
  transport: {
    fetchInit: () => ({ credentials: 'include' }),
  },
}
