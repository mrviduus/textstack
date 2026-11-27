/**
 * The platform seam (ADR-035): the only code that knows if the app runs on the web or in the Android shell.
 * Screens and hooks use `platform` and never ask which platform it is.
 *
 * The build picks the implementation: `VITE_TARGET=web` (the default) uses `web.ts`, `VITE_TARGET=android`
 * uses `android.ts`. `vite.config.ts` resolves `@platform-target` to one of the two files, so the other file
 * is not in the bundle.
 */
import type { ApiConfig } from '@textstack/shared'

export interface Platform {
  /** How calls to the API identify the reader. Web: the session cookie. Android: a bearer token. */
  transport: {
    /** The options of the shared API client (`initApi`), without `baseUrl`. */
    api: Omit<ApiConfig, 'baseUrl'>
    /** What a direct `fetch` to the API adds to its `RequestInit`. Synchronous: a write in `pagehide` uses it. */
    fetchInit(): { credentials?: RequestCredentials; headers?: Record<string, string> }
  }
}

export { platform } from '@platform-target'
