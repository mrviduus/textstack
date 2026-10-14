import { useCallback, useState } from 'react'

/**
 * #849: whether the engine failed to open this chapter, for the in-reader error, and the tries since (any
 * try: "still could not open it"). Another chapter starts over, so coming back retries; an open that lands
 * starts over too.
 */
export function useChapterEngineFailure(chapter: string) {
  const [state, setState] = useState({ chapter, failed: false, tries: 0 })
  // Reset while rendering, not in an effect: the chapter's own open (a child effect) runs first.
  const now = state.chapter === chapter ? state : { chapter, failed: false, tries: 0 }
  if (now !== state) setState(now)
  const onEngineError = useCallback((slug: string) => setState((s) => (s.chapter === slug ? { ...s, failed: true } : s)), [])
  const opened = useCallback((slug: string) => setState((s) => (s.chapter === slug ? { chapter: slug, failed: false, tries: 0 } : s)), [])
  /** A try: `reopen` mounts a fresh engine; else it missed and the error stays. */
  const tried = useCallback((reopen: boolean) => setState((s) => ({ ...s, failed: !reopen, tries: s.tries + 1 })), [])
  return { failed: now.failed, tries: now.tries, onEngineError, opened, tried }
}
