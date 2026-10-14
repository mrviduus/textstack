import { useCallback, useState } from 'react'

/**
 * #849: the chapter the engine failed to open, for the in-reader error. Another chapter clears it, so
 * coming back retries the open; so does `clear` (a Try again that landed, an open that landed).
 */
export function useChapterEngineFailure(chapter: string) {
  const [failedFor, setFailedFor] = useState<string | null>(null)
  // Reset while rendering, not in an effect: the chapter's own open (a child effect) runs first.
  const [seen, setSeen] = useState(chapter)
  if (seen !== chapter) {
    setSeen(chapter)
    setFailedFor(null)
  }
  const clear = useCallback((slug: string) => setFailedFor((f) => (f === slug ? null : f)), [])
  return { failed: failedFor === chapter, onEngineError: setFailedFor, clear }
}
