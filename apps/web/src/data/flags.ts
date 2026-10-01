import { getLanguage } from '@textstack/shared'

// Flag derived from ISO 3166 country code → Twemoji SVG (works on all platforms).
const TWEMOJI_BASE = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/svg'

function countryToTwemojiSlug(cc: string): string {
  if (!cc || cc.length !== 2) return ''
  const a = 0x1f1e6 + cc.toUpperCase().charCodeAt(0) - 65
  const b = 0x1f1e6 + cc.toUpperCase().charCodeAt(1) - 65
  return `${a.toString(16)}-${b.toString(16)}`
}

export function getFlagUrl(code: string): string {
  const lang = getLanguage(code)
  if (!lang) return ''
  const slug = countryToTwemojiSlug(lang.flagCountry)
  return slug ? `${TWEMOJI_BASE}/${slug}.svg` : ''
}
