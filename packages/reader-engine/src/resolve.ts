// The `goTo` resolution ladder (ADR-025): where a locator lands in a chapter's text, most confident
// first — the quoted text, the chapter fraction, the old pixel offset, the top. Pure: the engine core
// turns the answer into a scroll.
import type { GoToResult, Locator } from './api'
import { ANCHOR_CONTEXT_LENGTH, findAnchorOffset } from '../../shared/src/reader/textAnchor'

export type Resolved =
  | { result: Extract<GoToResult, 'exact' | 'fuzzy'>; offset: number }
  | { result: 'fraction'; fraction: number }
  | { result: 'legacyOffset'; scrollY: number }
  | { result: 'start' }

/** Null: the locator is for another chapter. Never a look-alike place in this one (ADR-015). */
export function resolveLocator(loc: Locator | null | undefined, href: string | undefined, text: string): Resolved | null {
  if (!loc) return { result: 'start' }
  if (loc.href !== href) return null

  const exact = loc.text?.highlight
  const hint = loc.locations.charOffset
  if (exact && text) {
    // No hint → NaN offsets, so findAnchorOffset skips its offset step.
    const start = Number.isInteger(hint) ? (hint as number) : NaN
    const at = findAnchorOffset(text, { prefix: loc.text?.before ?? '', exact, suffix: loc.text?.after ?? '', startOffset: start, endOffset: start + exact.length })
    if (at !== null) {
      const offset = Number.isInteger(hint) ? breakTie(text, exact, at, hint as number) : at
      return { result: text.startsWith(exact, offset) ? 'exact' : 'fuzzy', offset }
    }
  }
  const p = loc.locations.progression
  if (typeof p === 'number' && p > 0) return { result: 'fraction', fraction: Math.min(1, p) }
  const y = loc.locations.legacyScrollY
  if (typeof y === 'number' && y > 0) return { result: 'legacyOffset', scrollY: y }
  return { result: 'start' }
}

/**
 * The hint chooses only between occurrences the text cannot tell apart (identical context either
 * side: a reprinted paragraph, a refrain). It never overrides a context-unique match — the shared
 * `nearestOccurrence` did, which is the ADR-025 spike finding.
 */
function breakTie(text: string, exact: string, at: number, hint: number): number {
  const n = ANCHOR_CONTEXT_LENGTH
  const context = (i: number) => `${text.slice(Math.max(0, i - n), i)}\u0000${text.slice(i + exact.length, i + exact.length + n)}`
  const mine = context(at)
  let best = at
  for (let i = text.indexOf(exact); i !== -1; i = text.indexOf(exact, i + 1)) {
    if (Math.abs(i - hint) < Math.abs(best - hint) && context(i) === mine) best = i
  }
  return best
}
