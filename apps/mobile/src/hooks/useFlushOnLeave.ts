import { useLayoutEffect } from 'react'
import { useFlushOnBackground } from './useFlushOnBackground'

/**
 * `flush()` when the app goes to background and when the screen unmounts. A layout-effect cleanup, so a
 * child's ref (the WebView) is still attached when it runs. Pass a stable `flush`.
 */
export function useFlushOnLeave(flush: () => void): void {
  useFlushOnBackground(flush)
  useLayoutEffect(() => () => flush(), [flush])
}
