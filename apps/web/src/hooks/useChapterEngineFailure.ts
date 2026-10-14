import { useCallback, useState } from 'react'

/**
 * #849: the chapter the engine failed to open, for the in-reader error. Another chapter clears it, so
 * coming back retries the open; so does `clear` (Try again, or an open that lands on it).
 */
export function useChapterEngineFailure(chapter: string | undefined) {
  const [failedFor, setFailedFor] = useState<string | null>(null)
  // Reset while rendering, not in an effect: the chapter's own open (a child effect) runs first.
  const [seen, setSeen] = useState(chapter)
  if (seen !== chapter) {
    setSeen(chapter)
    setFailedFor(null)
  }
  const clear = useCallback((slug: string) => setFailedFor((f) => (f === slug ? null : f)), [])
  return { failed: !!chapter && failedFor === chapter, onEngineError: setFailedFor, clear }
}
