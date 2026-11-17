import { useAuth } from '../context/AuthContext'
import { FALLBACK_WPM } from '@textstack/shared'

export interface ReadingPaceDto {
  wpm: number
  sessionCount: number
  isUserSpecific: boolean
}

/** No per-reader pace on the server: every estimate reads at the default pace. */
export const FALLBACK_PACE: ReadingPaceDto = {
  wpm: FALLBACK_WPM,
  sessionCount: 0,
  isUserSpecific: false,
}

export function useReadingPace(): ReadingPaceDto {
  return FALLBACK_PACE
}

/** The pace in words per minute, `null` without a session: the V2 reader shows no time left then (#1262). */
export function useFetchedReadingPace(): number | null {
  return useAuth().isAuthenticated ? FALLBACK_PACE.wpm : null
}
