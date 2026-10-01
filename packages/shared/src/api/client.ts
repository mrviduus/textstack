export interface ApiConfig {
  baseUrl: string
  getAccessToken: () => Promise<string | null>
  /**
   * Called on a 401. Should refresh the access token and return the new
   * one, or null if refresh failed (user truly unauthenticated). Must be
   * single-flight internally — multiple concurrent 401s should share one
   * refresh.
   */
  onUnauthorized: () => Promise<string | null>
  /**
   * Cookie mode (web): `'include'` sends the session cookie on every request.
   * `getAccessToken` then returns null and `onUnauthorized` returns `''` after
   * a successful refresh — "retry with the cookie alone". Unset = Bearer mode
   * (mobile), where `''` still means "no token".
   */
  credentials?: RequestCredentials
}

let config: ApiConfig | null = null

export function initApi(c: ApiConfig) {
  config = c
}

export function getApiConfig(): ApiConfig {
  if (!config) throw new Error('API not initialized. Call initApi() first.')
  return config
}

/**
 * Wrapper around `fetch` that translates network/DNS/abort failures into
 * an `ApiError` with `isNetworkError === true`. Without this the caller
 * sees a raw `TypeError: Network request failed` and can't distinguish
 * "offline" from "backend crashed" or "parse error".
 */
async function safeFetch(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init)
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    const err = new ApiError(0, msg || 'Network request failed')
    err.isNetworkError = true
    throw err
  }
}

/**
 * True when a caught error means "the request never reached the server".
 *
 * `ApiError.isNetworkError` has been set correctly on every request since it was
 * added, and its docblock says UIs "can show 'check your connection' instead of
 * a generic server error". None did. Library, Discover and the book detail
 * screen all caught, logged to the console, and left their state at `[]` — so an
 * offline reader with twelve books was shown the empty state written for someone
 * who has never added one.
 *
 * **Check your own abort signal first.** A deliberate cancellation also fails
 * before reaching the server and is reported here as offline; only the caller
 * knows it aborted on purpose.
 */
export function isOfflineError(e: unknown): boolean {
  return e instanceof ApiError && e.isNetworkError
}

export function getStorageUrl(path: string | null | undefined): string | undefined {
  if (!path) return undefined
  // baseUrl is like "https://textstack.app/api" — storage is at origin, not under /api
  const base = getApiConfig().baseUrl.replace(/\/api\/?$/, '')
  return `${base}/storage/${path}`
}

function parseJsonSafe<T>(text: string, status: number): T {
  if (!text) return {} as T
  // Reject HTML responses (e.g. from redirect landing on SPA page)
  if (text.trimStart().startsWith('<')) {
    throw new ApiError(status, 'Unexpected HTML response from API')
  }
  return JSON.parse(text)
}

async function errorFromResponse(res: Response, fallbackStatus = res.status): Promise<ApiError> {
  const text = await res.text().catch(() => '')
  let message = `API error: ${fallbackStatus}`
  try {
    const json = JSON.parse(text)
    if (json?.error) message = json.error
    else if (json?.message) message = json.message
  } catch {
    // non-JSON body — keep the generic status message
  }
  return new ApiError(fallbackStatus, message)
}

export async function authFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const { baseUrl, getAccessToken, onUnauthorized, credentials } = getApiConfig()

  const token = await getAccessToken()
  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string>),
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  const res = await safeFetch(`${baseUrl}${path}`, { ...options, headers, ...(credentials && { credentials }) })

  if (res.status === 401) {
    const newToken = await onUnauthorized()
    if (newToken || (credentials && newToken === '')) {
      if (newToken) headers['Authorization'] = `Bearer ${newToken}`
      const retry = await safeFetch(`${baseUrl}${path}`, { ...options, headers, ...(credentials && { credentials }) })
      if (!retry.ok) {
        // Surface the *real* status/message from the retry, not a
        // generic "Unauthorized". Otherwise a 403/5xx after a
        // successful refresh looks like the refresh itself failed.
        throw await errorFromResponse(retry)
      }
      return parseJsonSafe<T>(await retry.text(), retry.status)
    }
    throw new ApiError(401, 'Unauthorized')
  }

  if (!res.ok) {
    throw await errorFromResponse(res)
  }

  return parseJsonSafe<T>(await res.text(), res.status)
}

export async function publicFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const { baseUrl, credentials } = getApiConfig()

  const res = await safeFetch(`${baseUrl}${path}`, credentials ? { ...options, credentials } : options)

  if (!res.ok) {
    throw await errorFromResponse(res)
  }

  return parseJsonSafe<T>(await res.text(), res.status)
}

/** Converts an object to a query string, skipping undefined/null values. */
export function buildQuery(params: Record<string, string | number | boolean | null | undefined>): string {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== '') qs.set(key, String(value))
  }
  const s = qs.toString()
  return s ? `?${s}` : ''
}

/** Returns RequestInit for a JSON POST/PUT/PATCH body. */
export function jsonBody(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', data: unknown): RequestInit {
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }
}

export class ApiError extends Error {
  /**
   * True when the request never reached the server (offline, DNS,
   * aborted, CORS, TLS). Status is 0 in that case. UIs can show "check
   * your connection" instead of a generic server error.
   */
  isNetworkError = false

  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
