import { useEffect, useState } from 'react'
import { getReadingPace, type ReadingPaceDto } from '../api/readingTracking'
import { useAuth, useV2 } from '../context/AuthContext'
import { FALLBACK_WPM, ApiError, v2Offers } from '@textstack/shared'

const CACHE_KEY = 'textstack.readingPace'
const TTL_MS = 60 * 60 * 1000

interface CachedPace { value: ReadingPaceDto; ts: number }

function readCache(): CachedPace | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as CachedPace
    if (!parsed || typeof parsed.ts !== 'number') return null
    return parsed
  } catch { return null }
}

function writeCache(value: ReadingPaceDto) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ value, ts: Date.now() }))
  } catch { /* quota exceeded — ignore */ }
}

export const FALLBACK_PACE: ReadingPaceDto = {
  wpm: FALLBACK_WPM,
  sessionCount: 0,
  isUserSpecific: false,
}

// One request per page: every UserBookCard calls this hook, and the localStorage
// cache is only written after the response, so a cold cache used to send N.
let inflight: Promise<ReadingPaceDto> | null = null
function loadPace(): Promise<ReadingPaceDto> {
  inflight ??= getReadingPace()
    .then((p) => { writeCache(p); return p })
    .finally(() => { inflight = null })
  return inflight
}

interface PaceState { pace: ReadingPaceDto; answered: boolean }

/** The pace and whether it is an answer (the server's, the cache's, or V2's fallback) rather than the placeholder. */
function usePace(): PaceState {
  const { isAuthenticated } = useAuth()
  // M5 (#1031): no pace route on V2: the legacy cache is not read, no call is made, and the fallback pace is the
  // answer, so the V2 reader keeps its time left.
  const offered = v2Offers(useV2(), 'readingStats')
  const [state, setState] = useState<PaceState>(() => {
    const cached = offered ? readCache() : null
    return cached ? { pace: cached.value, answered: true } : { pace: FALLBACK_PACE, answered: !offered }
  })

  useEffect(() => {
    if (!isAuthenticated) {
      setState({ pace: FALLBACK_PACE, answered: false })
      return
    }
    if (!offered) {
      setState({ pace: FALLBACK_PACE, answered: true })
      return
    }
    const cached = readCache()
    if (cached && Date.now() - cached.ts < TTL_MS) {
      setState({ pace: cached.value, answered: true })
      return
    }
    let cancelled = false
    loadPace()
      .then((p) => { if (!cancelled) setState({ pace: p, answered: true }) })
      // V2 refused the read (410) before any request, the probe having answered after this render: the fallback answers.
      .catch((e) => { if (!cancelled && e instanceof ApiError && e.status === 410) setState({ pace: FALLBACK_PACE, answered: true }) })
    return () => { cancelled = true }
  }, [isAuthenticated, offered])

  return state
}

export function useReadingPace(): ReadingPaceDto {
  return usePace().pace
}

/**
 * The pace in words per minute, `null` until there is one from the server (this call's answer or the cached
 * one): the V2 reader shows no time left before then (#1262). The server's own fallback pace is an answer, and
 * so is V2's (M5 #1031): the fallback pace.
 */
export function useFetchedReadingPace(): number | null {
  const { pace, answered } = usePace()
  return answered ? pace.wpm : null
}
