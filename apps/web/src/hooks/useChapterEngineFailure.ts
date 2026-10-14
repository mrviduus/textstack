import { useCallback, useEffect, useState } from 'react'

/**
 * #849: the chapter the engine failed to open, for ReaderPage's chapter error. Another chapter clears it,
 * so coming back retries the open; an open that lands on it clears it too.
 */
export function useChapterEngineFailure(chapter: string | undefined) {
  const [failedFor, setFailedFor] = useState<string | null>(null)
  useEffect(() => { setFailedFor(null) }, [chapter])
  const onEngineOpened = useCallback((slug: string) => setFailedFor((f) => (f === slug ? null : f)), [])
  return { failed: !!chapter && failedFor === chapter, onEngineError: setFailedFor, onEngineOpened }
}
