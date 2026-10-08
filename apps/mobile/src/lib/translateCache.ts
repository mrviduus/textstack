import { translationApi, type TranslateContext } from '@textstack/shared'
import { createSingleFlight, type SingleFlight } from './singleFlight'

export type SaveCategory = 'common' | 'learnable' | 'rare'
export type CachedTranslation = { translation: string; category?: SaveCategory }

// In-memory translation cache shared by the reader's selection toolbar, the
// vocab save path, the Translate sheet, and the gloss backfill. Wins:
//   1. Re-tapping a word is instant (no network round-trip).
//   2. De-dupes the double translate per tap.
//   3. Carries the backend's single-word frequency "category" so the toolbar
//      can recommend (not gate) saving.
// Session-scoped; the backend file cache covers cross-session reuse.
const cache = new Map<string, CachedTranslation>()

/**
 * In-flight calls, keyed exactly like `cache`.
 *
 * Point 2 above was a claim this file could not keep. It memoized the RESULT
 * and nothing else, so two callers inside the same ~1s window both read
 * `cache.get(k) === undefined`, both called the API, and both were billed:
 * `/translate` is OpenAI `gpt-4.1-nano`, on the most frequent action in the
 * product. The server-side file cache does not save you either — the second
 * request reads a cache entry the first one has not written yet.
 *
 * `createSingleFlight` is REUSED rather than reimplemented. Its one job is
 * "N callers, one call, everyone gets the same promise, and the slot is
 * released on BOTH settlements", which is precisely the rule needed here, and
 * it is the version of that rule this repo already has tests for. The only
 * thing it lacks is a key, and a key is a `Map` — cheaper and far less
 * dangerous than a second hand-rolled promise-tracking implementation whose
 * release-on-reject path would have to be got right all over again.
 *
 * Entries are evicted once the call settles, so the map never outgrows the
 * words actually in flight (the resolved values live in `cache`).
 */
const inFlight = new Map<string, SingleFlight<CachedTranslation>>()

// The sentence is part of the key, as it is of the server's: "wound" in "she
// wound the clock" and in "the wound bled" are two different translations.
const keyOf = (text: string, from: string, to: string, ctx?: TranslateContext) =>
  `${from}|${to}|${text.trim().toLowerCase()}|${ctx?.sentence?.trim() ?? ''}`

/** Synchronous peek — lets the toolbar render instantly on a cache hit. */
export function peekTranslation(text: string, from: string, to: string, ctx?: TranslateContext): CachedTranslation | undefined {
  return cache.get(keyOf(text, from, to, ctx))
}

/** Cached translate. On miss, hits the API once and memoizes a non-empty result. */
export async function cachedTranslate(text: string, from: string, to: string, ctx?: TranslateContext): Promise<CachedTranslation> {
  const k = keyOf(text, from, to, ctx)
  const hit = cache.get(k)
  if (hit !== undefined) return hit

  let slot = inFlight.get(k)
  if (!slot) {
    slot = createSingleFlight<CachedTranslation>()
    inFlight.set(k, slot)
  }
  const claimed = slot
  const call = claimed.run(async () => {
    const res = await translationApi.translate(text, from, to, undefined, ctx) as { translatedText?: string; translation?: string; category?: SaveCategory }
    const out: CachedTranslation = { translation: res.translatedText || res.translation || '', category: res.category }
    if (out.translation) cache.set(k, out)
    return out
  })

  // Evict on BOTH settlements, for the same reason `singleFlight` releases on
  // both: a slot left behind after a failure would hand every later caller the
  // one stale rejection, and translation would stay broken for the rest of the
  // process. `run` has already cleared its own slot by the time this runs
  // (it settles `call` from inside its own handlers), so `isInFlight` is the
  // honest test for "nobody re-entered while we were settling".
  const evict = () => {
    if (!claimed.isInFlight && inFlight.get(k) === claimed) inFlight.delete(k)
  }
  call.then(evict, evict)

  return call
}
