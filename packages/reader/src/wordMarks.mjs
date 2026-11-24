// Saved-word marks (#1271): the reader's saved words underlined by SRS stage, with their translation above them
// behind the reader's setting. Pure, page and both hosts. The host sends the words once per open (`markWords`); the
// page places them one section at a time as sections load, by the vocabulary key the apps use (text.ts
// `matchWords`: whole words, any case, phrases first). Words and glosses are the reader's data, drawn as text only.
import { matchWords, rangesIn, textNodes } from './text'

/** At most this many words in a `markWords` list; a word, a gloss at most this long (the server's caps: 200, 500). */
export const MAX_WORDS = 20000
export const MAX_WORD = 200
export const MAX_GLOSS = 500
/** The legacy readers' underline per SRS stage (web decorationColors, mobile readerColors): new, recognition, recall, context, mastered. */
export const STAGE_COLORS = ['rgba(59,130,246,0.5)', 'rgba(234,179,8,0.5)', 'rgba(234,179,8,0.4)', 'rgba(34,197,94,0.4)', 'rgba(34,197,94,0.25)']
/** A stage as drawn: one off the list is drawn as new (the legacy readers' fallback). */
export const stageOf = (s) => (Number.isInteger(s) && s >= 0 && s < STAGE_COLORS.length ? s : 0)

/**
 * The page's read of a host's `markWords` list: `{ word, stage, gloss }`, malformed items dropped (not a string, blank,
 * too long), a gloss off its cap or blank is none. Anything that is not a list is none. Over MAX_WORDS, the newest are
 * kept: hosts send their words oldest first, a word just saved last.
 */
export function readMarkWords(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const w of raw.slice(-MAX_WORDS)) {
    if (!w || typeof w !== 'object' || typeof w.word !== 'string' || !w.word.trim() || w.word.length > MAX_WORD) continue
    const gloss = typeof w.gloss === 'string' && w.gloss.trim() && w.gloss.length <= MAX_GLOSS ? w.gloss.trim() : null
    out.push({ word: w.word, stage: stageOf(w.stage), gloss })
  }
  return out
}

/**
 * Where `words` stand in `root` (a section's body): one `{ range, word }` per occurrence, in document order. A block or
 * a footnote ends a word; a phrase is matched before its words (text.ts `matchWords`).
 */
export function wordMarksIn(root, words) {
  if (!root || !words.length) return []
  const nodes = textNodes(root)
  const at = rangesIn(root, nodes)
  // matchWords' offsets are in these very nodes: every one has its range.
  return matchWords(root, words, nodes).map((m) => ({ range: at(m.start, m.end - m.start), word: m.item }))
}

/** A label as drawn above its word: its first meaning, before a comma, semicolon, slash or bracket ("a (b)" → "a"). */
export const shortGloss = (text) => text.split(/[,;/(（]/)[0].trim() || text.trim()

/** Whether two marks draw the same (a section re-marked keeps what did not change). */
export const sameMark = (a, b) => !!a && !!b && a.stage === b.stage && a.gloss === b.gloss

/**
 * The legacy readers' setting, reused ("the existing setting"): `showInlineTranslations` in their stored settings
 * JSON (web `reader.settings.v1`; Android's `useReaderSettings` reads its own). On unless the reader turned it off.
 */
export const GLOSS_SETTING = 'showInlineTranslations'
export function readGlosses(json) {
  try { return JSON.parse(json)?.[GLOSS_SETTING] !== false } catch { return true }
}
/** That stored JSON with the setting changed, every other field kept (a damaged value: only the setting). */
export function withGlosses(json, on) {
  let o = null
  try { o = JSON.parse(json) } catch { /* none */ }
  return JSON.stringify({ ...(o && typeof o === 'object' && !Array.isArray(o) ? o : {}), [GLOSS_SETTING]: !!on })
}
