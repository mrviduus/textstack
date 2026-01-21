/**
 * Semantic params to keep in canonical URLs.
 * All other params (tracking: utm_*, gclid, fbclid, etc.) are stripped.
 */
const SEMANTIC_PARAMS = ['q']

/**
 * Strips www. prefix from domain
 */
function stripWww(url: string): string {
  return url.replace(/^(https?:\/\/)www\./i, '$1')
}

/**
 * Forces https scheme
 */
function forceHttps(url: string): string {
  return url.replace(/^http:/i, 'https:')
}

/**
 * Removes trailing slash except for root path
 */
function removeTrailingSlash(url: string): string {
  // Parse URL to check if path is root
  try {
    const parsed = new URL(url)
    if (parsed.pathname !== '/' && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1)
      return parsed.toString()
    }
    return url
  } catch {
    // If URL parsing fails, just remove trailing slash from end
    return url.replace(/\/(\?|#|$)/, '$1')
  }
}

/**
 * Filters search params, keeping only semantic ones
 */
function filterSearchParams(search: string): string {
  if (!search) return ''

  const params = new URLSearchParams(search)
  const filtered = new URLSearchParams()

  for (const key of SEMANTIC_PARAMS) {
    const value = params.get(key)
    if (value) {
      filtered.set(key, value)
    }
  }

  const result = filtered.toString()
  return result ? `?${result}` : ''
}

export interface CanonicalOptions {
  /** Origin to use (e.g., https://textstack.app). Falls back to window.location.origin */
  origin?: string
  /** URL pathname (e.g., /en/books/foo) */
  pathname: string
  /** Search string including ? (e.g., ?q=test&utm_source=google) */
  search?: string
}

/**
 * Builds a canonical URL with:
 * - https scheme
 * - no www prefix
 * - tracking params stripped
 * - semantic params preserved (?q=)
 * - no trailing slash (except root)
 */
export function buildCanonicalUrl(options: CanonicalOptions): string {
  const { pathname, search = '' } = options
  let origin = options.origin || (typeof window !== 'undefined' ? window.location.origin : '')

  // Normalize origin
  origin = forceHttps(origin)
  origin = stripWww(origin)
  // Remove trailing slash from origin
  origin = origin.replace(/\/$/, '')

  // Filter search params
  const filteredSearch = filterSearchParams(search)

  // Build URL
  let url = `${origin}${pathname}${filteredSearch}`

  // Remove trailing slash
  url = removeTrailingSlash(url)

  return url
}

/**
 * Normalizes a domain for canonical use:
 * - Forces https
 * - Strips www
 */
export function normalizeOrigin(domain: string): string {
  let origin = domain.startsWith('http') ? domain : `https://${domain}`
  origin = forceHttps(origin)
  origin = stripWww(origin)
  return origin.replace(/\/$/, '')
}
