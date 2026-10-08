// Stored shapes ↔ Locator (ADR-025 §5). One pair per shape. A locator read from a stored value keeps
// it in `ext.stored`; the same kind's mapper writes it back byte-identically while the locator still
// says what the value says. A moved or fresh locator writes a new value, and only one the readers
// accept — otherwise null, never a plausible-looking wrong one.
import type { Locator, StoredKind } from './api'
import { parseTextPosition, serializeTextPosition, TEXT_POSITION_VERSION } from '../../shared/src/reader/textPosition'
import { isPdfAnchor } from '../../shared/src/reader/pdfHighlightAnchor'
import { parsePdfPageLocator } from '../../shared/src/reader/pdfProgress'
import { parseScrollLocator } from '../../shared/src/reader/progressPayload'
import { PROGRESS_LOCATOR_END, PROGRESS_LOCATOR_START } from '../../shared/src/reader/progressLocators'

function parseObject(json: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(json)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const isPage = (n: unknown): n is number => Number.isInteger(n) && (n as number) >= 1
const stored = (kind: StoredKind, value: string, href?: string) => ({ kind, value, href })
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const isRects = (v: unknown): v is { x: number; y: number; w: number; h: number }[] =>
  Array.isArray(v) && v.every((r) => r && num(r.x) && num(r.y) && num(r.w) && num(r.h))

/** Key-order-independent JSON, so a spread copy of a locator compares equal to the original. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v)
}
const meaning = (l: Locator) => canon({ href: l.href, type: l.type, locations: l.locations, text: l.text, rects: l.ext?.rects })

/** The stored value, if `loc` came from one of this kind and still means the same thing. */
function unchanged(loc: Locator, kind: StoredKind, reread: (value: string) => Locator | null): string | null {
  const s = loc.ext?.stored
  if (!s || s.kind !== kind) return null
  const again = reread(s.value)
  return again && meaning(again) === meaning(loc) ? s.value : null
}

/** A highlight's TextAnchor. It carries no slug, so the host passes the chapter in. */
export function anchorToLocator(json: string, href: string): Locator | null {
  const a = parseObject(json)
  if (!a || a.kind === 'pdf' || typeof a.exact !== 'string' || a.exact.length === 0) return null
  return {
    href,
    type: 'text/html',
    locations: typeof a.startOffset === 'number' ? { charOffset: a.startOffset } : {},
    text: { before: str(a.prefix), highlight: a.exact, after: str(a.suffix) },
    ext: { stored: stored('anchor', json, href) },
  }
}

/** Without a charOffset this writes the phone's shape (no offsets), which every resolver accepts. */
export function locatorToAnchor(loc: Locator | null): string | null {
  if (!loc) return null
  const same = unchanged(loc, 'anchor', (v) => anchorToLocator(v, loc.href ?? ''))
  if (same) return same
  const exact = loc.text?.highlight
  if (!exact) return null
  const anchor: Record<string, unknown> = { prefix: loc.text?.before ?? '', exact, suffix: loc.text?.after ?? '' }
  const at = loc.locations.charOffset
  if (Number.isInteger(at) && (at as number) >= 0) {
    anchor.startOffset = at
    anchor.endOffset = (at as number) + exact.length
  }
  // A moved highlight is still the same highlight: keep who made it. `source:'mcp'` is what the
  // assistant write cap counts (HighlightsEndpoints.MaxAssistantHighlightsPerBook).
  const s = loc.ext?.stored
  const was = s?.kind === 'anchor' ? parseObject(s.value) : null
  // The chapter id only while it is still that chapter.
  if (typeof was?.chapterId === 'string' && s?.href === loc.href) anchor.chapterId = was.chapterId
  if (typeof was?.source === 'string') anchor.source = was.source
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
    ext: { stored: stored('position', json) },
  }
}

export function locatorToPosition(loc: Locator | null): string | null {
  if (!loc) return null
  const same = unchanged(loc, 'position', positionToLocator)
  if (same) return same
  const exact = loc.text?.highlight
  const at = loc.locations.charOffset
  if (!loc.href || !exact || !Number.isInteger(at) || (at as number) < 0) return null
  const p = loc.locations.progression
  return serializeTextPosition({
    v: TEXT_POSITION_VERSION,
    chapterSlug: loc.href,
    anchor: { prefix: loc.text?.before ?? '', exact, suffix: loc.text?.after ?? '', startOffset: at as number, endOffset: (at as number) + exact.length },
    charOffset: at as number,
    // The reader clamps the same way, so what is written reads back unchanged.
    chapterFraction: typeof p === 'number' && Number.isFinite(p) ? Math.min(1, Math.max(0, p)) : 0,
  })
}

/** A highlight on an Original-layout PDF page (page geometry, ADR-012). */
export function pdfAnchorToLocator(json: string): Locator | null {
  const a = parseObject(json)
  if (!isPdfAnchor(a) || !isPage(a.page) || !isRects(a.rects) || typeof a.exact !== 'string') return null
  return {
    type: 'application/pdf',
    locations: { position: a.page },
    text: { highlight: a.exact },
    ext: { stored: stored('pdf', json), rects: a.rects },
  }
}

export function locatorToPdfAnchor(loc: Locator | null): string | null {
  if (!loc) return null
  const same = unchanged(loc, 'pdf', pdfAnchorToLocator)
  if (same) return same
  const page = loc.locations.position
  const rects = loc.ext?.rects
  if (!isPage(page) || !isRects(rects)) return null
  return JSON.stringify({ v: 1, kind: 'pdf', page, rects, exact: loc.text?.highlight ?? '' })
}

/** The progress row's locator string: `page:<N>`, `chapter:<slug>`, `scroll:<slug>:<px>`, `percent:<n>`, sentinels. */
export function progressToLocator(s: string): Locator | null {
  const page = parsePdfPageLocator(s)
  if (page) return { type: 'application/pdf', locations: { position: page }, ext: { stored: stored('progress', s) } }
  const chapter = /^chapter:(.+)$/.exec(s)
  if (chapter) return { href: chapter[1], type: 'text/html', locations: { progression: 0 }, ext: { stored: stored('progress', s) } }
  const scroll = parseScrollLocator(s)
  if (scroll) return { href: scroll.slug, type: 'text/html', locations: { legacyScrollY: scroll.offset }, ext: { stored: stored('progress', s) } }
  // Book-level only: "finished" / "start over" sentinels and web's `percent:<0..1>`.
  const book = s === PROGRESS_LOCATOR_END ? 1 : s === PROGRESS_LOCATOR_START ? 0 : /^percent:(\d+(?:\.\d+)?)$/.exec(s)?.[1]
  const total = typeof book === 'string' ? Number(book) : book
  if (typeof total === 'number' && total >= 0 && total <= 1) return { type: 'text/html', locations: { totalProgression: total }, ext: { stored: stored('progress', s) } }
  return null
}

/**
 * Old builds read this string, so a reflow position is written as `scroll:` until Phase 6. Without a
 * `legacyScrollY` there is nothing truthful to write: null, never `chapter:` ("the top").
 */
export function locatorToProgress(loc: Locator | null): string | null {
  if (!loc) return null
  const same = unchanged(loc, 'progress', progressToLocator)
  if (same) return same
  if (loc.type === 'application/pdf') return isPage(loc.locations.position) ? `page:${loc.locations.position}` : null
  const y = loc.locations.legacyScrollY
  if (!loc.href || typeof y !== 'number' || !Number.isFinite(y)) return null
  return `scroll:${loc.href}:${Math.max(0, Math.round(y))}`
}
