import type { Platform } from '.'

/** Loaded on the first 401, not at start: a static import makes a cycle through `api/client.ts`, which reads `platform` on load. */
const refreshToken = () => import('../api/auth').then((m) => m.refreshToken())

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
