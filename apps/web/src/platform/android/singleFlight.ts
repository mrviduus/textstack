/**
 * One slot, one in-flight call — the dedupe primitive behind guest minting.
 *
 * `POST /auth/guest` is rate limited to a handful of mints per IP per window
 * and every extra mint that gets through leaves an orphaned `User` row on the
 * server that no one can ever sign into again. So the interesting property is
 * not "fewer requests"; it is that two callers can never end up holding two
 * different sessions.
 *
 * Deliberately a tiny factory rather than a `useRef` inside `AuthContext`:
 * `src/lib/**` is the only mobile layer Vitest collects (`vitest.config.ts`),
 * so this is the only shape of the rule that can be tested at all.
 */
export interface SingleFlight<T> {
  /**
   * Run `task`, or join the call already running. All joiners get the SAME
   * promise — same resolution, same rejection.
   */
  run(task: () => Promise<T>): Promise<T>
  /** Whether a call is currently occupying the slot. Diagnostics/tests only. */
  readonly isInFlight: boolean
}

export function createSingleFlight<T>(): SingleFlight<T> {
  let current: Promise<T> | null = null

  return {
    run(task: () => Promise<T>): Promise<T> {
      if (current) return current

      let started: Promise<T>
      try {
        started = task()
      } catch (err) {
        // A task that throws synchronously never occupied the slot, so there
        // is nothing to release. Returning a rejected promise (instead of
        // rethrowing) keeps `run` uniformly async for callers.
        return Promise.reject(err)
      }

      // The slot is released on BOTH settlements. Releasing only on success
      // is the classic version of this bug: one failed mint (offline, 429)
      // would wedge the slot forever, and every later `ensureSession()` for
      // the rest of the process would hand back that one stale rejection —
      // the reader would never get a session again until the app restarted.
      const tracked: Promise<T> = started.then(
        (value) => {
          if (current === tracked) current = null
          return value
        },
        (err) => {
          if (current === tracked) current = null
          throw err
        },
      )

      current = tracked
      return tracked
    },
    get isInFlight() {
      return current !== null
    },
  }
}
