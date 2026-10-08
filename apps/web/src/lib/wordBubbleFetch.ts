// Shared "open word popup" data pipeline:
//   1. Definition mode (native == book language): contextual Explain → `definition`
//   2. Translation fetch → target-lang text
//   3. Hand the translation + sentence to updateTranslation (TR-2 owns the overwrite rule)
//
// Caller owns bubble state + abort controller; we kick off the async fetches and
// merge results via `patch`, which the caller guards against a stale bubble word.

import { explain as explainApi } from '../api/explain'
import { translate as translateApi } from '../api/translation'

/** Subset of bubble fields the fetcher touches — caller extends their full state. */
export interface WordBubbleFetchFields {
  definition?: string | null
  definitionLoading?: boolean
  translation?: string | null
  translationLoading?: boolean
}

interface FetchWordBubbleOpts {
  word: string
  bookLanguage: string
  targetLang: string | null
  /** Definition mode: nothing to translate, so fetch the contextual Explain instead.
   *  Caller sets `definitionLoading: true` on the bubble when this is true. */
  explainInContext: boolean
  updateTranslation: (word: string, translation: string, sentence?: string) => void
  signal: AbortSignal
  /** Merge a partial update into the active bubble if it's still the same word.
   *  Caller implements the stale-word guard using their bubble state. */
  patch: (fields: WordBubbleFetchFields) => void
  /** Optional book id (editionId or userBookId). Forwarded to the translation
   *  endpoint so it can pick a domain-aware reading. */
  bookId?: string | null
  /** Optional surrounding sentence — same disambiguation purpose. */
  sentence?: string | null
}

export function fetchWordBubble(opts: FetchWordBubbleOpts) {
  const {
    word, bookLanguage, targetLang,
    explainInContext, updateTranslation,
    signal, patch,
    bookId, sentence,
  } = opts

  // Explain (definition mode only). Any failure (rate limit, 503, offline) shows nothing.
  if (explainInContext) {
    explainApi({ word, sentence: sentence || word, bookId, targetLang: bookLanguage }, signal)
      .then((res) => {
        if (signal.aborted) return
        patch({ definition: res?.explanation || null, definitionLoading: false })
      })
      .catch(() => {
        if (signal.aborted) return
        patch({ definitionLoading: false })
      })
  }

  // Translation fetch (no save). Skipped in same-lang definition mode.
  if (!targetLang) return
  translateApi(word, bookLanguage, targetLang, signal, { bookId, sentence })
    .then((res) => {
      if (signal.aborted) return
      const translatedText = res?.translatedText ?? null
      patch({ translation: translatedText, translationLoading: false })
      if (translatedText) updateTranslation(word, translatedText, sentence ?? undefined)
    })
    .catch((err) => {
      if (signal.aborted) return
      if ((err as { name?: string })?.name === 'AbortError') return
      patch({ translationLoading: false })
    })
}
