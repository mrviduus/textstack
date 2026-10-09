import { publicFetch, jsonBody } from './client'

export interface TranslationResult {
  translatedText: string
  /** Single-word save recommendation from the backend frequency filter:
   *  'common' (likely known) | 'learnable' (worth saving) | 'rare' | undefined
   *  (phrase / non-English / unknown). Informational only — never gates save. */
  category?: 'common' | 'learnable' | 'rare'
}

/** What lets the server pick the sense of an ambiguous word. */
export interface TranslateContext {
  /** The sentence the word was tapped in. */
  sentence?: string | null
  /** editionId / userBookId — the server biases the prompt by the book's genre. */
  bookId?: string | null
}

/** TR-1: the one translate body for every client. A word or short selection (<= 3 words AND
 *  <= 40 chars, not the sentence itself) carries its sentence; a passage is its own context. */
export function translateBody(text: string, source: string, target: string, ctx?: TranslateContext) {
  const t = text.trim()
  const body: { text: string; sourceLang: string; targetLang: string; sentence?: string; bookId?: string } =
    { text: t, sourceLang: source, targetLang: target }
  const sentence = ctx?.sentence?.trim()
  if (sentence && sentence !== t && t.split(/\s+/).length <= 3 && t.length <= 40) body.sentence = sentence
  if (ctx?.bookId) body.bookId = ctx.bookId
  return body
}

/** TR-1: the one client cache key — built from the body actually sent, text case kept. */
export function translateCacheKey(text: string, source: string, target: string, ctx?: TranslateContext) {
  const body = translateBody(text, source, target, ctx)
  return JSON.stringify([source, target, body.text, body.sentence ?? '', body.bookId ?? ''])
}

export function translate(text: string, source: string, target: string, signal?: AbortSignal, ctx?: TranslateContext) {
  const opts = jsonBody('POST', translateBody(text, source, target, ctx))
  if (signal) opts.signal = signal
  return publicFetch<TranslationResult>('/translate', opts)
}
