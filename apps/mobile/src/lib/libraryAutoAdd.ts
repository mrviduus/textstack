export type AutoAddDeps = {
  wasRemoved: (userId: string, editionId: string) => Promise<boolean>
  isOnline: () => Promise<boolean>
  /** POST /me/library/{id} — idempotent server-side (200 when already there). */
  add: (editionId: string) => Promise<unknown>
}

const MAX_ATTEMPTS = 2 // the first try and one retry, per book per session

/**
 * A catalog book joins the library once the reader is 1% in — web's `useReaderLibraryTracking`.
 *
 * Once per book per account per app session (the reader remounts on every chapter). No library
 * download to check membership: the POST is idempotent. Skips books the reader removed, does not
 * try at all offline, and after a failure retries once — a 5xx must not become a request per save.
 */
export function createLibraryAutoAdd(deps: AutoAddDeps) {
  const done = new Set<string>()
  const failures = new Map<string, number>()
  const inFlight = new Map<string, Promise<void>>()
  const key = (userId: string, editionId: string) => `${userId}:${editionId}`

  const maybeAdd = async (userId: string, editionId: string, bookPercent: number | null | undefined): Promise<void> => {
    if (bookPercent == null || bookPercent < 0.01) return
    const k = key(userId, editionId)
    if (done.has(k) || inFlight.has(k) || (failures.get(k) ?? 0) >= MAX_ATTEMPTS) return
    // Registered before the first await, so `settled` sees it from the moment it starts.
    const run = (async () => {
      try {
        if (!(await deps.isOnline())) return
        if (!(await deps.wasRemoved(userId, editionId))) await deps.add(editionId)
        done.add(k)
      } catch (e) {
        failures.set(k, (failures.get(k) ?? 0) + 1)
        console.warn('[library] auto-add failed', e)
      } finally {
        inFlight.delete(k)
      }
    })()
    inFlight.set(k, run)
    await run
  }

  /** Resolves once any add for this book is over — read the library after it, not before. */
  const settled = (userId: string, editionId: string): Promise<void> =>
    inFlight.get(key(userId, editionId)) ?? Promise.resolve()

  return { maybeAdd, settled }
}
