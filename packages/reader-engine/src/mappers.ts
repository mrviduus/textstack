// Stored shapes ↔ Locator (ADR-025 §5). One pair per shape. A locator read from a stored value keeps
// it in `ext.stored` and maps back to it byte-identically; only a fresh locator writes a new value.
import type { Locator } from './api'
import { parseTextPosition, serializeTextPosition, TEXT_POSITION_VERSION } from '../../shared/src/reader/textPosition'
import { isPdfAnchor } from '../../shared/src/reader/pdfHighlightAnchor'
import { parsePdfPageLocator } from '../../shared/src/reader/pdfProgress'
import { parseScrollLocator } from '../../shared/src/reader/progressPayload'

function parseObject(json: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(json)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

/** A highlight's TextAnchor. It carries no slug, so the host passes the chapter in. */
export function anchorToLocator(json: string, href: string): Locator | null {
  const a = parseObject(json)
  if (!a || a.kind === 'pdf' || typeof a.exact !== 'string' || a.exact.length === 0) return null
  return {
    href,
    type: 'text/html',
    locations: typeof a.startOffset === 'number' ? { charOffset: a.startOffset } : {},
    text: { before: str(a.prefix), highlight: a.exact, after: str(a.suffix) },
    ext: { stored: json },
  }
}

export function locatorToAnchor(loc: Locator | null): string | null {
  if (!loc) return null
  if (loc.ext?.stored) return loc.ext.stored
  const exact = loc.text?.highlight
  if (!exact) return null
  const anchor: Record<string, unknown> = { prefix: loc.text?.before ?? '', exact, suffix: loc.text?.after ?? '' }
  const at = loc.locations.charOffset
  if (typeof at === 'number') {
    anchor.startOffset = at
    anchor.endOffset = at + exact.length
  }
  return JSON.stringify(anchor)
}

/** A reading position (TextPosition v1, ADR-015). */
export function positionToLocator(json: string): Locator | null {
  const p = parseTextPosition(json)
  if (!p) return null
  return {
    href: p.chapterSlug,
    type: 'text/html',
    locations: { progression: p.chapterFraction, charOffset: p.charOffset },
    text: { before: p.anchor.prefix, highlight: p.anchor.exact, after: p.anchor.suffix },
    ext: { stored: json },
  }
}

export function locatorToPosition(loc: Locator | null): string | null {
  if (!loc) return null
  if (loc.ext?.stored) return loc.ext.stored
  const exact = loc.text?.highlight
  if (!loc.href || !exact) return null
  const at = loc.locations.charOffset ?? 0
  return serializeTextPosition({
    v: TEXT_POSITION_VERSION,
    chapterSlug: loc.href,
    anchor: { prefix: loc.text?.before ?? '', exact, suffix: loc.text?.after ?? '', startOffset: at, endOffset: at + exact.length },
    charOffset: at,
    chapterFraction: loc.locations.progression ?? 0,
  })
}

/** A highlight on an Original-layout PDF page (page geometry, ADR-012). */
export function pdfAnchorToLocator(json: string): Locator | null {
  const a = parseObject(json)
  if (!isPdfAnchor(a)) return null
  return {
    type: 'application/pdf',
    locations: { position: a.page },
    text: { highlight: a.exact },
    ext: { stored: json, rects: a.rects },
  }
}

export function locatorToPdfAnchor(loc: Locator | null): string | null {
  if (!loc) return null
  if (loc.ext?.stored) return loc.ext.stored
  const page = loc.locations.position
  if (!page || !loc.ext?.rects) return null
  return JSON.stringify({ v: 1, kind: 'pdf', page, rects: loc.ext.rects, exact: loc.text?.highlight ?? '' })
}

/** The progress row's locator string: `page:<N>`, `chapter:<slug>`, `scroll:<slug>:<px>`. */
export function progressToLocator(s: string): Locator | null {
  const page = parsePdfPageLocator(s)
  if (page) return { type: 'application/pdf', locations: { position: page }, ext: { stored: s } }
  const chapter = /^chapter:(.+)$/.exec(s)
  if (chapter) return { href: chapter[1], type: 'text/html', locations: { progression: 0 }, ext: { stored: s } }
  const scroll = s.startsWith('scroll:') ? parseScrollLocator(s) : null
  if (scroll) return { href: scroll.slug, type: 'text/html', locations: { legacyScrollY: scroll.offset }, ext: { stored: s } }
  return null
}

export function locatorToProgress(loc: Locator | null): string | null {
  if (!loc) return null
  if (loc.ext?.stored) return loc.ext.stored
  if (loc.type === 'application/pdf') return loc.locations.position ? `page:${Math.floor(loc.locations.position)}` : null
  if (!loc.href) return null
  const y = loc.locations.legacyScrollY
  return typeof y === 'number' ? `scroll:${loc.href}:${Math.max(0, Math.round(y))}` : `chapter:${loc.href}`
}
