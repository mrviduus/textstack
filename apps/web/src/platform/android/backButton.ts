/**
 * The Android Back key. One native listener; what is open on top (a sheet, the reader's panel) registers a
 * handler, and Back runs the newest one. With none: one step back in the app's history, or out of the app when
 * there is no step. A listener replaces Capacitor's own handling of the key, so this does both parts.
 */
const handlers: (() => void)[] = []
let listening = false

function listen() {
  if (listening) return
  listening = true
  void import('@capacitor/app').then(({ App }) =>
    App.addListener('backButton', ({ canGoBack }) => {
      const top = handlers[handlers.length - 1]
      if (top) top()
      else if (canGoBack) window.history.back()
      else void App.exitApp()
    }),
  ).catch((e: unknown) => {
    listening = false
    console.warn('[shell] no Back key listener:', e)
  })
}

/** `handler` gets Back until the returned function is called. */
export function onBackButton(handler: () => void): () => void {
  listen()
  handlers.push(handler)
  return () => {
    const at = handlers.lastIndexOf(handler)
    if (at !== -1) handlers.splice(at, 1)
  }
}

/** The key works from the app's start, with nothing registered. */
export const startBackButton = listen
