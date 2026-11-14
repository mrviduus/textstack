import { useState, useCallback, useEffect, useRef } from 'react'
import { explain as explainApi, API_BASE, type ExplainRequest } from '../api/explain'
import { postSse, SseUnsupportedError } from '../lib/sse'
import { getCachedExplain, cacheExplain } from '../lib/offlineDb'

interface ExplainState {
  explanation: string | null
  isLoading: boolean
  error: string | null
  cached: boolean
}

const INITIAL: ExplainState = {
  explanation: null,
  isLoading: false,
  error: null,
  cached: false,
}

/**
 * Contextual word explanation, streamed (AI-032): `explanation` grows token-by-token while
 * `isLoading` stays true until the server's `done` event. Local offline cache is checked first;
 * environments that can't stream fall back to the JSON request. External shape is unchanged from
 * the pre-streaming hook, so consumers render incrementally for free.
 */
export function useExplain() {
  const [state, setState] = useState<ExplainState>(INITIAL)
  const abortRef = useRef<AbortController | null>(null)
  // An unmounted reader (its popup or route gone) stops the stream it started.
  useEffect(() => () => abortRef.current?.abort(), [])

  const explain = useCallback(async (req: ExplainRequest): Promise<string | null> => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setState({ explanation: null, isLoading: true, error: null, cached: false })

    const targetLang = (req.targetLang || 'en').split('-')[0]

    try {
      const hit = await getCachedExplain(req.word, req.sentence, req.genre, targetLang)
      if (hit) {
        setState({
          explanation: hit.explanation,
          isLoading: false,
          error: null,
          cached: true,
        })
        return hit.explanation
      }
    } catch {
      // cache read failed — fall through
    }

    if (!navigator.onLine) {
      setState({ explanation: null, isLoading: false, error: 'Offline', cached: false })
      return null
    }

    let text = ''
    let cached = false
    let serverError: string | null = null

    try {
      await postSse(
        `${API_BASE}/explain`,
        req,
        e => {
          if (ctrl.signal.aborted) return
          if (e.event === 'delta') {
            text += e.data
            setState({ explanation: text, isLoading: true, error: null, cached: false })
          } else if (e.event === 'done') {
            try {
              cached = Boolean((JSON.parse(e.data) as { cached?: boolean }).cached)
            } catch {
              // malformed done payload — text already accumulated, treat as uncached
            }
          } else if (e.event === 'error') {
            serverError = e.data || 'Explain failed'
          }
        },
        ctrl.signal,
      )

      if (serverError || !text) {
        // Keep any partial text visible alongside the error.
        setState({
          explanation: text || null,
          isLoading: false,
          error: serverError ?? 'Explain failed',
          cached: false,
        })
        return null
      }

      setState({ explanation: text, isLoading: false, error: null, cached })
      cacheExplain(req.word, req.sentence, req.genre, targetLang, text).catch(() => {})
      return text
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') return null

      // No streaming support (old browser / degraded env) → one-shot JSON request.
      if (err instanceof SseUnsupportedError) {
        try {
          const result = await explainApi(req, ctrl.signal)
          setState({ explanation: result.explanation, isLoading: false, error: null, cached: result.cached })
          cacheExplain(req.word, req.sentence, req.genre, targetLang, result.explanation).catch(() => {})
          return result.explanation
        } catch (fallbackErr) {
          if ((fallbackErr as { name?: string })?.name === 'AbortError') return null
          const error = fallbackErr instanceof Error ? fallbackErr.message : 'Explain failed'
          setState({ explanation: null, isLoading: false, error, cached: false })
          return null
        }
      }

      const error = err instanceof Error ? err.message : 'Explain failed'
      setState({ explanation: text || null, isLoading: false, error, cached: false })
      return null
    }
  }, [])

  const reset = useCallback(() => {
    abortRef.current?.abort()
    setState(INITIAL)
  }, [])

  return { ...state, explain, reset }
}
