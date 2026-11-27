import type { Platform } from '.'
import { refreshToken } from '../api/auth'

/** The web app: the session is an HttpOnly cookie. */
export const platform: Platform = {
  transport: {
    // Cookie mode: no bearer token. A 401 refreshes the cookie (single-flight in `refreshToken`), then the
    // client retries once. `''` means "retry with the cookie only".
    api: {
      getAccessToken: async () => null,
      onUnauthorized: () => refreshToken().then(() => '', () => null),
      credentials: 'include',
    },
    fetchInit: () => ({ credentials: 'include' }),
  },
}
