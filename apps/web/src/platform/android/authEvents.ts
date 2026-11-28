/**
 * Tiny auth event bus.
 *
 * The API layer (`api.ts`) lives outside React, but needs to tell the
 * AuthContext when a refresh has permanently failed so the UI can flip
 * out of `isAuthenticated` and navigate to the sign-in screen. A global
 * emitter decouples the two without threading a callback through every
 * fetch.
 */

type Listener = () => void

const listeners = new Set<Listener>()

/** Subscribe to auth failures. Returns an unsubscribe function. */
export function onAuthFailure(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/**
 * Fire all listeners. Safe to call from any context — each listener is
 * wrapped so a throw in one doesn't prevent the others from running.
 */
export function emitAuthFailure(): void {
  for (const cb of listeners) {
    try {
      cb()
    } catch (err) {
      // A broken listener shouldn't silence the rest.
      console.warn('[authEvents] listener threw:', err)
    }
  }
}
