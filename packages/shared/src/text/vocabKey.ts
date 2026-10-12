// Single source of truth for "what counts as a vocabulary word key".
// Covers: Unicode letters/marks/numbers + straight & curly apostrophes + hyphens.
// Always NFC-normalized + lowercased.
const WORD_RE = /[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’\-]*/u
const WORD_RE_G = /[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N}'’\-]*/gu

/** Extract the first word-like token from arbitrary text (e.g. selection.text). */
export function extractVocabKey(text: string): string | null {
  if (!text) return null
  const m = text.normalize('NFC').match(WORD_RE)
  return m ? m[0].toLowerCase() : null
}

/** Normalize an already-token string (e.g. map key or entry word). */
export function normalizeVocabKey(word: string): string {
  return word.normalize('NFC').toLowerCase()
}

/** Tokenize a full text (for VocabWordLayer underlining). */
export function tokenizeVocabWords(text: string): { word: string; start: number; end: number }[] {
  const tokens: { word: string; start: number; end: number }[] = []
  const src = text.normalize('NFC')
  let m: RegExpExecArray | null
  WORD_RE_G.lastIndex = 0
  while ((m = WORD_RE_G.exec(src)) !== null) {
    tokens.push({ word: m[0], start: m.index, end: m.index + m[0].length })
  }
  return tokens
}
