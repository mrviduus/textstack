import { useEffect, useState } from 'react'
import { getReadingPace, type ReadingPaceDto } from '../api/readingTracking'
import { useAuth } from '../context/AuthContext'
import { FALLBACK_WPM, ApiError } from '@textstack/shared'

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

export function useReadingPace(): ReadingPaceDto {
  const { isAuthenticated } = useAuth()
  const [pace, setPace] = useState<ReadingPaceDto>(() => readCache()?.value ?? FALLBACK_PACE)

  useEffect(() => {
    if (!isAuthenticated) {
      setPace(FALLBACK_PACE)
      return
    }
    const cached = readCache()
    if (cached && Date.now() - cached.ts < TTL_MS) {
      setPace(cached.value)
      return
    }
    let cancelled = false
    loadPace()
      .then((p) => { if (!cancelled) setPace(p) })
      // M5 (#1031): V2 has no pace route and refuses the read (410) before any request: the fallback pace
      // is then the answer (a copy, so `useFetchedReadingPace` counts it), and the V2 reader keeps its time left.
      .catch((e) => { if (!cancelled && e instanceof ApiError && e.status === 410) setPace({ ...FALLBACK_PACE }) })
    return () => { cancelled = true }
  }, [isAuthenticated])

  return pace
}

/**
 * The pace in words per minute, `null` until there is one from the server (this call's answer or the cached
 * one): the V2 reader shows no time left before then (#1262). The server's own fallback pace is an answer, and
 * so is a V2 refusal (M5 #1031): the fallback pace.
 */
export function useFetchedReadingPace(): number | null {
  const pace = useReadingPace()
  return pace === FALLBACK_PACE ? null : pace.wpm
}
