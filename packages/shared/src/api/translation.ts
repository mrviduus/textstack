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

export function translateBody(text: string, source: string, target: string, ctx?: TranslateContext) {
  const body: Record<string, string> = { text, sourceLang: source, targetLang: target }
  if (ctx?.sentence?.trim()) body.sentence = ctx.sentence
  if (ctx?.bookId) body.bookId = ctx.bookId
  return body
}

export function translate(text: string, source: string, target: string, signal?: AbortSignal, ctx?: TranslateContext) {
  const opts = jsonBody('POST', translateBody(text, source, target, ctx))
  if (signal) opts.signal = signal
  return publicFetch<TranslationResult>('/translate', opts)
}
