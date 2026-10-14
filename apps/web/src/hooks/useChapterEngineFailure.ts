import { useCallback, useState } from 'react'

/**
 * #849: the chapter the engine failed to open, for the in-reader error. A new chapter object clears it:
 * another chapter (coming back retries the open) or a fresh load of this one (Try again's refetch). An
 * open that lands on it clears it too.
 */
export function useChapterEngineFailure(chapter: { identifier: string }) {
  const [failedFor, setFailedFor] = useState<string | null>(null)
  // Reset while rendering, not in an effect: the chapter's own open (a child effect) runs first.
  const [seen, setSeen] = useState(chapter)
  if (seen !== chapter) {
    setSeen(chapter)
    setFailedFor(null)
  }
  const clear = useCallback((slug: string) => setFailedFor((f) => (f === slug ? null : f)), [])
  return { failed: failedFor === chapter.identifier, onEngineError: setFailedFor, clear }
}
