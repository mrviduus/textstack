import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'
import { useLanguage, SupportedLanguage } from '../context/LanguageContext'
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

// SEO length limits
// - Title: Google SERP truncates ~60 chars desktop; Ahrefs flags >70
// - Description: Google SERP truncates ~155-160 chars desktop; Ahrefs flags >160
const MAX_TITLE_LENGTH = 70
const MAX_DESCRIPTION_LENGTH = 160

/** Truncate text to maxLen, breaking at last word boundary and appending ellipsis */
function truncateSeo(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  const trimmed = text.slice(0, maxLen - 1)
  const lastSpace = trimmed.lastIndexOf(' ')
  return (lastSpace > maxLen * 0.6 ? trimmed.slice(0, lastSpace) : trimmed) + '…'
}

// Get canonical origin - env var, the production host, or window.location
function getCanonicalOrigin(): string {
  // 1. VITE_CANONICAL_URL env var
  const envCanonical = import.meta.env.VITE_CANONICAL_URL
  if (envCanonical) {
    return normalizeOrigin(envCanonical)
  }

  // 2. Detect production domain from hostname
  const host = window.location.hostname
  if (host === 'textstack.app' || host === 'www.textstack.app') {
    return 'https://textstack.app'
  }

  // 3. Fallback to current origin (for local dev)
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

  useEffect(() => {
    const origin = getCanonicalOrigin()
    const canonicalUrl = buildCanonicalUrl({
      origin,
      pathname: location.pathname,
      search: location.search,
    })
    const rawTitle = title
      ? title.toLowerCase().includes('textstack')
        ? title
        : `${title} | TextStack Reader`
      : 'TextStack Reader'
    const fullTitle = truncateSeo(rawTitle, MAX_TITLE_LENGTH)

    // Set canonical URL
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

    // Set description (truncated to SEO-optimal length)
    const safeDescription = description ? truncateSeo(description, MAX_DESCRIPTION_LENGTH) : undefined
    if (safeDescription) {
      let meta = document.querySelector('meta[name="description"]') as HTMLMetaElement | null
      if (!meta) {
        meta = document.createElement('meta')
        meta.name = 'description'
        document.head.appendChild(meta)
      }
      meta.content = safeDescription
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
    setMeta('og:site_name', 'TextStack Reader', 'property')
    if (safeDescription) {
      setMeta('og:description', safeDescription, 'property')
    }
    const ogImage = image
      ? (image.startsWith('http') ? image : `${origin}${image}`)
      : `${origin}/web-app-manifest-512x512.png`
    setMeta('og:image', ogImage, 'property')

    // Twitter Card tags
    setMeta('twitter:card', image ? 'summary_large_image' : 'summary', 'name')
    setMeta('twitter:title', fullTitle, 'name')
    if (safeDescription) {
      setMeta('twitter:description', safeDescription, 'name')
    }
    setMeta('twitter:image', ogImage, 'name')

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
  }, [location.pathname, location.search, title, description, image, type, availableLanguages, language, noindex, statusCode])

  return null
}
