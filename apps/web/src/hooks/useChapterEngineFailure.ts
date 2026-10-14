import { useCallback, useState } from 'react'

/**
 * #849: the chapter the engine failed to open, for the in-reader error. A new load clears it (`loadId`
 * from useReaderChapter): another chapter, so coming back retries the open, or Try again's refetch, even
 * with the same html. A failed refetch lands nothing, so the error stays. An open that lands clears it too.
 */
export function useChapterEngineFailure(chapter: string, loadId: number) {
  const [failedFor, setFailedFor] = useState<string | null>(null)
  // Reset while rendering, not in an effect: the chapter's own open (a child effect) runs first.
  const key = `${chapter}\n${loadId}`
  const [seen, setSeen] = useState(key)
  if (seen !== key) {
    setSeen(key)
    setFailedFor(null)
  }
  const clear = useCallback((slug: string) => setFailedFor((f) => (f === slug ? null : f)), [])
  return { failed: failedFor === chapter, onEngineError: setFailedFor, clear }
}
