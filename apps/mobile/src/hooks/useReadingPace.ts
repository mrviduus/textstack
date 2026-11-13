import { useEffect, useState } from 'react'
import { readingTrackingApi, FALLBACK_WPM } from '@textstack/shared'

let cached: number | null = null

/**
 * The reader's words-per-minute, for time-remaining estimates.
 *
 * The server already derives this from real sessions and falls back to a
 * population figure when it has too few (`GET /me/reading/pace`, cached an hour
 * server-side). Web has used it on library cards since slice 19; the reader —
 * where "how much longer?" is actually asked — never did, on either platform.
 *
 * Held in a module-level cache because pace changes over weeks, not within a
 * reading session, and every reader mount would otherwise refetch it.
 */
export function useReadingPace(enabled: boolean): number {
  return useFetchedReadingPace(enabled) ?? FALLBACK_WPM
}

/**
 * The same pace, `null` until the call has answered (or when it failed with nothing cached): the V2 reader
 * shows no time left before then (#1262). The server's own fallback pace is an answer.
 */
export function useFetchedReadingPace(enabled: boolean): number | null {
  const [wpm, setWpm] = useState<number | null>(cached)

  useEffect(() => {
    if (!enabled || cached != null) return
    let cancelled = false
    readingTrackingApi.getReadingPace()
      .then(p => {
        if (cancelled) return
        // Guard the wire value: a zero would divide by zero downstream.
        if (typeof p?.wpm === 'number' && p.wpm > 0) {
          cached = p.wpm
          setWpm(p.wpm)
        }
      })
      .catch(() => { /* offline or signed out — the fallback pace is fine */ })
    return () => { cancelled = true }
  }, [enabled])

  return wpm
}
