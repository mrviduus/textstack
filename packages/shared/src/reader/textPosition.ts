/**
 * Where the reader is, expressed as a place in the TEXT.
 *
 * [ADR-007](../../../../docs/01-architecture/adr/ADR-007-reader-autosave.md), accepted
 * 2026-01-19, decided this and said why: *"The system stores a logical position in the text, not
 * visual coordinates… The following are explicitly not used: scrollY, page numbers,
 * viewport-based coordinates."* Its acceptance criteria include **"Font changes do not break
 * progress"**. Four months later `scroll:<slug>:<pixelOffset>` shipped anyway, and sixteen commits
 * across web and mobile have since defended it — each fixing a real defect, none of them this one.
 * A pixel offset stops being true the moment the text reflows, and the reader's next automatic save
 * then makes the untruth permanent.
 *
 * ADR-007 proposed `paragraph_index` + `offset_in_paragraph`. That is not available and the reason
 * is specific rather than general: the index of a `<p>` within a chapter survives a font change
 * perfectly well — it is a DOM fact, not a text fact — but re-ingestion deletes and recreates every
 * chapter from freshly parsed HTML (`IngestionService`), and the two clients sanitise differently.
 * A text anchor survives both, and one already exists here, resolving highlights across exactly
 * these changes. Its own docstring names the case: *"A highlight, a bookmark **or a reading
 * position** cannot be stored as a pixel offset or a character index."*
 *
 * So: a reading position is a highlight without a colour.
 */

import { ANCHOR_CONTEXT_LENGTH, findAnchorOffset, type TextAnchor } from './textAnchor'

/**
 * The version, on the wire.
 *
 * The server stores this opaquely, both clients write it, and old builds keep writing the pixel
 * locator beside it — so a stored position outlives the code that wrote it by a long way. A number
 * that says which shape it is costs two bytes and is the difference between "we can change this"
 * and "we can never change this".
 */
export const TEXT_POSITION_VERSION = 1

/**
 * How much text to quote from the reading line.
 *
 * Long enough to be near-unique in prose — 64 characters is roughly a line — and short enough to
 * stay under `findFuzzyMatch`'s `exact.length >= 100` bail-out, so the sliding-window fallback still
 * applies to a passage whose text was edited. A highlight quotes whatever the reader selected; this
 * has to choose, and choosing short would put it in the same trouble as `charOffset`: "the" appears
 * in every chapter.
 */
export const POSITION_QUOTE_LENGTH = 64

/** Serialised form is capped server-side; keep the two numbers in sight of each other. */
export const MAX_SERIALISED_LENGTH = 4096

export interface TextPosition {
  v: number
  /**
   * The chapter, by slug — never by id.
   *
   * Re-ingestion recreates chapters, so their Guids change; the slug is regenerated from the title
   * and survives while the title does. `resume.ts` reached the same conclusion from the other
   * direction and states it as a rule: the locator is the position, and everything derived from a
   * chapter id can lag.
   */
  chapterSlug: string
  /** The passage under the reading line, with `ANCHOR_CONTEXT_LENGTH` of context either side. */
  anchor: TextAnchor
  /**
   * Character offset of that passage within the chapter's text.
   *
   * A hint, verified and never trusted — `findAnchorOffset` already treats `startOffset` that way.
   * It costs four bytes and rescues the case a text anchor cannot: a passage that genuinely repeats,
   * where the surrounding context matches equally well in both places.
   */
  charOffset: number
  /**
   * How far through the chapter, 0..1.
   *
   * The coarse fallback when the anchor resolves to nothing — an image-heavy chapter can move text
   * further than any anchor reaches — and the input `computeBookProgress` already takes. Deliberately
   * NOT a book-wide percentage: that number lives in its own column with its own declared unit, and
   * adding a second one is the mistake ADR-013 §3 warns about, at a third field.
   */
  chapterFraction: number
}

/** Build a position from what a viewer measured. Returns null when there is nothing to anchor to. */
export function buildTextPosition(input: {
  chapterSlug: string
  chapterText: string
  charOffset: number
  chapterFraction: number
}): TextPosition | null {
  const { chapterSlug, chapterText } = input
  if (!chapterSlug || typeof chapterText !== 'string' || chapterText.length === 0) return null

  const start = clampInt(input.charOffset, 0, chapterText.length)
  const exact = chapterText.slice(start, start + POSITION_QUOTE_LENGTH)
  // A position at the very end of a chapter has nothing left to quote. The fraction still says
  // where the reader is, so the caller keeps that and loses only the precision.
  if (exact.length === 0) return null

  return {
    v: TEXT_POSITION_VERSION,
    chapterSlug,
    anchor: {
      prefix: chapterText.slice(Math.max(0, start - ANCHOR_CONTEXT_LENGTH), start),
      exact,
      suffix: chapterText.slice(start + exact.length, start + exact.length + ANCHOR_CONTEXT_LENGTH),
      startOffset: start,
      endOffset: start + exact.length,
    },
    charOffset: start,
    chapterFraction: clampUnit(input.chapterFraction),
  }
}

export function serializeTextPosition(pos: TextPosition | null | undefined): string | null {
  if (!pos) return null
  const json = JSON.stringify(pos)
  // Refuse to emit what the server will refuse to store, rather than sending it and letting the
  // position silently vanish. A chapter slug is the only unbounded field, and a pathological one
  // is the shape that gets here.
  return json.length > MAX_SERIALISED_LENGTH ? null : json
}

/**
 * Parse a stored position. Returns null for anything this build cannot act on — including a version
 * it does not know, which is the point of having one.
 */
export function parseTextPosition(json: string | null | undefined): TextPosition | null {
  if (typeof json !== 'string' || json.length === 0 || json.length > MAX_SERIALISED_LENGTH) return null
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Partial<TextPosition>
  if (p.v !== TEXT_POSITION_VERSION) return null
  if (typeof p.chapterSlug !== 'string' || p.chapterSlug.length === 0) return null
  const a = p.anchor as Partial<TextAnchor> | undefined
  if (!a || typeof a.exact !== 'string' || a.exact.length === 0) return null
  return {
    v: TEXT_POSITION_VERSION,
    chapterSlug: p.chapterSlug,
    anchor: {
      prefix: typeof a.prefix === 'string' ? a.prefix : '',
      exact: a.exact,
      suffix: typeof a.suffix === 'string' ? a.suffix : '',
      startOffset: clampInt(a.startOffset, 0, Number.MAX_SAFE_INTEGER),
      endOffset: clampInt(a.endOffset, 0, Number.MAX_SAFE_INTEGER),
    },
    charOffset: clampInt(p.charOffset, 0, Number.MAX_SAFE_INTEGER),
    chapterFraction: clampUnit(p.chapterFraction),
  }
}

/** What a viewer should do with a stored position, in the order it should try. */
export type ResolvedPosition =
  /** The anchor was found in this chapter's text. `offset` is where. */
  | { kind: 'anchor'; offset: number }
  /** The anchor resolved to nothing; fall back to the fraction of the chapter. */
  | { kind: 'fraction'; fraction: number }

/**
 * Resolve a stored position against the text actually on screen.
 *
 * `chapterSlug` is the chapter the viewer is showing. A position for a DIFFERENT chapter resolves to
 * nothing rather than to a plausible-looking place in this one — that substitution is the exact
 * failure this whole exercise is about, and the caller has a route it can change instead.
 */
export function resolveTextPosition(
  pos: TextPosition | null | undefined,
  chapterSlug: string | null | undefined,
  chapterText: string | null | undefined,
): ResolvedPosition | null {
  if (!pos || !chapterSlug || pos.chapterSlug !== chapterSlug) return null
  if (typeof chapterText === 'string' && chapterText.length > 0) {
    const at = findAnchorOffset(chapterText, pos.anchor)
    if (at !== null) return { kind: 'anchor', offset: nearestOccurrence(chapterText, pos, at) }
  }
  if (pos.chapterFraction > 0) return { kind: 'fraction', fraction: pos.chapterFraction }
  return null
}

/**
 * The occurrence the reader actually stopped at, when the text says the same thing twice.
 *
 * `findAnchorOffset` weighs the surroundings of each occurrence and takes the best. That is right
 * for a highlight — a reader selected a specific passage, and its context is what identifies it —
 * but it cannot separate two occurrences whose context is IDENTICAL, and it takes the first. For a
 * reading position that is a real case: a serialised novel that reprints the previous instalment's
 * closing paragraphs, a poetry collection with a repeated refrain, a badly split chapter appended
 * twice by an extractor.
 *
 * `charOffset` is the tie-break, and this is the "passage that genuinely repeats" its docstring
 * promises. It is used ONLY to choose between candidates the resolver already accepts — never to
 * override it, and never to invent a position of its own, because the offset is the half that a
 * re-parse invalidates.
 */
function nearestOccurrence(text: string, pos: TextPosition, resolved: number): number {
  const exact = pos.anchor.exact
  let index = text.indexOf(exact)
  if (index === -1) return resolved
  const second = text.indexOf(exact, index + 1)
  if (second === -1) return resolved   // unique: nothing to choose between

  let best = resolved
  let bestDistance = Math.abs(resolved - pos.charOffset)
  for (; index !== -1; index = text.indexOf(exact, index + 1)) {
    const distance = Math.abs(index - pos.charOffset)
    if (distance < bestDistance) { bestDistance = distance; best = index }
  }
  return best
}

function clampInt(n: unknown, min: number, max: number): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return min
  return Math.max(min, Math.min(max, Math.round(n)))
}

function clampUnit(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}
