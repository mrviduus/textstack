import { publicFetch, jsonBody } from './client'

export interface TranslationResult {
  translatedText: string
  /** Single-word save recommendation from the backend frequency filter:
   *  'common' (likely known) | 'learnable' (worth saving) | 'rare' | undefined
   *  (phrase / non-English / unknown). Informational only — never gates save. */
  category?: 'common' | 'learnable' | 'rare'
}

/** What lets the server pick the right sense of an ambiguous word. */
export interface TranslateContext {
  /** The sentence the word was tapped in ("pocketed the coins" ≠ "buried"). */
  sentence?: string | null
  /** editionId / userBookId — the server biases the prompt by the book's genre. */
  bookId?: string | null
}

/** A word or short phrase gets its sentence as context; a passage is its own context. */
const MAX_CONTEXT_WORDS = 3

/** The one place every client's translate body is built — web and mobile both route here. */
export function translateBody(text: string, source: string, target: string, ctx?: TranslateContext) {
  const body: Record<string, string> = { text, sourceLang: source, targetLang: target }
  const sentence = ctx?.sentence?.trim()
  const words = text.trim().split(/\s+/).filter(Boolean).length
  if (sentence && words <= MAX_CONTEXT_WORDS && sentence.toLowerCase() !== text.trim().toLowerCase()) {
    body.sentence = ctx!.sentence!
  }
  if (ctx?.bookId) body.bookId = ctx.bookId
  return body
}

/** The one client cache-key rule (web IndexedDB, mobile memory): derived from the body
 *  `translateBody` sends, so a key varies exactly as the server's answer can. */
export function translateCacheKey(text: string, source: string, target: string, ctx?: TranslateContext) {
  const body = translateBody(text, source, target, ctx)
  // Case kept: "US" ≠ "us", "Turkey" ≠ "turkey" (the server keys the raw text too).
  // JSON, not a joined string: a "|" inside the text or sentence cannot shift fields.
  return JSON.stringify([source, target, text.trim(), body.sentence?.trim() ?? '', body.bookId ?? ''])
}

export function translate(text: string, source: string, target: string, signal?: AbortSignal, ctx?: TranslateContext) {
  const opts = jsonBody('POST', translateBody(text, source, target, ctx))
  if (signal) opts.signal = signal
  return publicFetch<TranslationResult>('/translate', opts)
}
