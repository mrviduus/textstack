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
 * Normalizes trailing slash:
 * - Root paths (/, /en/, /uk/) keep trailing slash
 * - Deeper paths (/en/books, /en/search) have trailing slash removed
 */
function normalizeTrailingSlash(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname

    // Root path or language root (/en/, /uk/) - keep trailing slash
    const isRootLike = path === '/' || /^\/[a-z]{2}\/?$/.test(path)

    if (isRootLike) {
      if (!path.endsWith('/')) {
        parsed.pathname += '/'
      }
    } else {
      // Deeper paths - remove trailing slash
      if (path.endsWith('/')) {
        parsed.pathname = path.slice(0, -1)
      }
    }

    return parsed.toString()
  } catch {
    return url
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
 * - trailing slash only for root paths (/, /en/, /uk/)
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

  // Normalize trailing slash
  url = normalizeTrailingSlash(url)

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

/**
 * Gets the canonical origin for building URLs.
 * Priority:
 * 1. Provided primaryDomain from site context
 * 2. VITE_CANONICAL_URL env var
 * 3. Production domain detection
 * 4. Current window.location.origin
 */
export function getCanonicalOrigin(primaryDomain?: string): string {
  // 1. Use primaryDomain from site context if available
  if (primaryDomain) {
    return normalizeOrigin(primaryDomain)
  }

  // 2. Use VITE_CANONICAL_URL env var (for prerender where site context may not load)
  const envCanonical = import.meta.env.VITE_CANONICAL_URL
  if (envCanonical) {
    return normalizeOrigin(envCanonical)
  }

  // 3. Detect production domain from hostname
  if (typeof window !== 'undefined') {
    const host = window.location.hostname
    if (host === 'textstack.app' || host === 'www.textstack.app') {
      return 'https://textstack.app'
    }
  }

  // 4. Fallback to current origin (for local dev)
  if (typeof window !== 'undefined') {
    return normalizeOrigin(window.location.origin)
  }

  return ''
}
