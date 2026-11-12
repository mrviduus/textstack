import { useLayoutEffect } from 'react'
import { useFlushOnBackground } from './useFlushOnBackground'

/**
 * `flush()` when the app goes to background: that save lands (the screen and its message handler are still there).
 * Also on unmount, best effort only: a WebView page's answer (its `store`) comes back to a handler that is gone, so
 * an unmount flush saves nothing there. A path that must save closes the book first, with the screen alive (the V2
 * reader's back and top bar, `CLOSE_BOOK_JS`). A layout-effect cleanup, so a child's ref is still attached. Pass a
 * stable `flush`.
 */
export function useFlushOnLeave(flush: () => void): void {
  useFlushOnBackground(flush)
  useLayoutEffect(() => () => flush(), [flush])
}
