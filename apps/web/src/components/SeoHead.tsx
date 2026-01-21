import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useLanguage, SupportedLanguage } from '../context/LanguageContext'
import { useSite } from '../context/SiteContext'
import { buildCanonicalUrl, normalizeOrigin } from '../lib/canonicalUrl'

interface SeoHeadProps {
  title?: string
  description?: string
  image?: string
  type?: 'website' | 'book' | 'profile'
  availableLanguages?: SupportedLanguage[]
  noindex?: boolean
  statusCode?: number // HTTP status for prerender (e.g., 404 for not found)
}

const HREFLANG_DATA_ATTR = 'data-hreflang-managed'
const OG_DATA_ATTR = 'data-og-managed'

// Get canonical origin - use primaryDomain from site config, env var, or fallback to window.location
function getCanonicalOrigin(primaryDomain: string | undefined): string {
  // 1. Use primaryDomain from site context if available
  if (primaryDomain) {
    return normalizeOrigin(primaryDomain)
  }

  // 2. Use VITE_CANONICAL_URL env var (for prerender where site context may not load in time)
  const envCanonical = import.meta.env.VITE_CANONICAL_URL
  if (envCanonical) {
    return normalizeOrigin(envCanonical)
  }

  // 3. Detect production domain from hostname
  const host = window.location.hostname
  if (host === 'textstack.app' || host === 'www.textstack.app') {
    return 'https://textstack.app'
  }

  // 4. Fallback to current origin (for local dev)
  return normalizeOrigin(window.location.origin)
}

function setMeta(property: string, content: string, attr: string) {
  const selector = `meta[${attr}="${property}"]`
  let meta = document.querySelector(selector) as HTMLMetaElement | null
  if (!meta) {
    meta = document.createElement('meta')
    meta.setAttribute(attr, property)
    meta.setAttribute(OG_DATA_ATTR, 'true')
    document.head.appendChild(meta)
  }
  meta.content = content
}

export function SeoHead({
  title,
  description,
  image,
  type = 'website',
  availableLanguages,
  noindex,
  statusCode,
}: SeoHeadProps) {
  const location = useLocation()
  const { language } = useLanguage()
  const { site } = useSite()

  useEffect(() => {
    // Wait for site context to load before setting SEO tags
    // This ensures canonical URLs use the correct domain
    const origin = getCanonicalOrigin(site?.primaryDomain)
    const canonicalUrl = buildCanonicalUrl({
      origin,
      pathname: location.pathname,
      search: location.search,
    })
    const fullTitle = title ? `${title} | TextStack` : 'TextStack'

    // Set canonical URL (always set, will update when site loads)
    let link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null
    if (!link) {
      link = document.createElement('link')
      link.rel = 'canonical'
      document.head.appendChild(link)
    }
    link.href = canonicalUrl

    // Set title
    if (title) {
      document.title = fullTitle
    }

    // Set description
    if (description) {
      let meta = document.querySelector('meta[name="description"]') as HTMLMetaElement | null
      if (!meta) {
        meta = document.createElement('meta')
        meta.name = 'description'
        document.head.appendChild(meta)
      }
      meta.content = description
    }

    // Set robots meta
    let robotsMeta = document.querySelector('meta[name="robots"]') as HTMLMetaElement | null
    if (noindex) {
      if (!robotsMeta) {
        robotsMeta = document.createElement('meta')
        robotsMeta.name = 'robots'
        document.head.appendChild(robotsMeta)
      }
      robotsMeta.content = 'noindex,follow'
    } else if (robotsMeta) {
      robotsMeta.remove()
    }

    // Set prerender status code (for prerender service to return correct HTTP status)
    let statusMeta = document.querySelector('meta[name="prerender-status-code"]') as HTMLMetaElement | null
    if (statusCode) {
      if (!statusMeta) {
        statusMeta = document.createElement('meta')
        statusMeta.name = 'prerender-status-code'
        document.head.appendChild(statusMeta)
      }
      statusMeta.content = String(statusCode)
    } else if (statusMeta) {
      statusMeta.remove()
    }

    // Open Graph tags
    setMeta('og:title', fullTitle, 'property')
    setMeta('og:url', canonicalUrl, 'property')
    setMeta('og:type', type, 'property')
    setMeta('og:site_name', 'TextStack', 'property')
    if (description) {
      setMeta('og:description', description, 'property')
    }
    if (image) {
      const imageUrl = image.startsWith('http') ? image : `${origin}${image}`
      setMeta('og:image', imageUrl, 'property')
    }

    // Twitter Card tags
    setMeta('twitter:card', image ? 'summary_large_image' : 'summary', 'name')
    setMeta('twitter:title', fullTitle, 'name')
    if (description) {
      setMeta('twitter:description', description, 'name')
    }
    if (image) {
      const imageUrl = image.startsWith('http') ? image : `${origin}${image}`
      setMeta('twitter:image', imageUrl, 'name')
    }

    // Set hreflang tags
    document.querySelectorAll(`link[${HREFLANG_DATA_ATTR}]`).forEach((el) => el.remove())

    if (availableLanguages && availableLanguages.length > 0) {
      const pathWithoutLang = location.pathname.replace(/^\/(uk|en)/, '')

      availableLanguages.forEach((lang) => {
        const hreflangLink = document.createElement('link')
        hreflangLink.rel = 'alternate'
        hreflangLink.hreflang = lang
        hreflangLink.href = buildCanonicalUrl({
          origin,
          pathname: `/${lang}${pathWithoutLang}`,
          search: location.search,
        })
        hreflangLink.setAttribute(HREFLANG_DATA_ATTR, 'true')
        document.head.appendChild(hreflangLink)
      })

      const xDefaultLink = document.createElement('link')
      xDefaultLink.rel = 'alternate'
      xDefaultLink.hreflang = 'x-default'
      xDefaultLink.href = buildCanonicalUrl({
        origin,
        pathname: `/${language}${pathWithoutLang}`,
        search: location.search,
      })
      xDefaultLink.setAttribute(HREFLANG_DATA_ATTR, 'true')
      document.head.appendChild(xDefaultLink)
    }

    return () => {
      document.querySelectorAll(`link[${HREFLANG_DATA_ATTR}]`).forEach((el) => el.remove())
    }
  }, [location.pathname, location.search, title, description, image, type, availableLanguages, language, noindex, statusCode, site?.primaryDomain])

  return null
}
