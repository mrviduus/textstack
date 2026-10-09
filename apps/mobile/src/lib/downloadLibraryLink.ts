import type { EnsureSessionResult } from './guestSession'

/**
 * LIB-1: Download adds the book to the Library; cancelling a download that added it takes it back
 * out; a book saved by hand stays. "Added by download" is remembered only when the Library state was
 * known to be not-in-library and the add succeeded — never remove what we are not sure we added.
 */
export function downloadLibraryLink() {
  let added: Promise<boolean> | null = null
  // Any add the Download started, known state or not — a later DELETE must not overtake its POST.
  let inFlight: Promise<unknown> = Promise.resolve()
  return {
    start(state: 'in' | 'out' | 'unknown', add: () => Promise<boolean>) {
      if (state === 'in') return
      const p = add()
      inFlight = p.catch(() => {})
      if (state === 'out') added = p
    },
    /** Waits for the in-flight add first, so the DELETE never overtakes its POST. */
    async cancel(remove: () => unknown) {
      const p = added
      added = null
      if (p && await p) await remove()
    },
    /** A hand Save/remove, or that download finishing or being removed, ends the link. Resolves once the in-flight add settles. */
    forget(): Promise<void> { added = null; return inFlight.then(() => {}) },
  }
}

/**
 * The Download tap (LIB-1): the download at once, then the Library save. With no session a guest is
 * minted first, as SessionGate does — a download is intent, and the book must land in the Library
 * (LIB-1a, ADR-014). Nothing waits on the mint (the download already runs), so a slow mint still
 * saves when it answers; a failed one leaves the book downloaded, unsaved. A mint discarded because
 * another session won saves under that session, if one holds a token.
 * `save(true)` = a guest minted just now, whose Library is known to be empty.
 */
export async function downloadAndSave(o: {
  run: () => unknown
  hasSession: boolean
  ensureSession: () => Promise<EnsureSessionResult>
  getAccessToken: () => Promise<string | null>
  save: (freshGuest: boolean) => void
}): Promise<void> {
  void o.run()
  if (o.hasSession) return o.save(false)
  const r = await o.ensureSession().catch(() => null)
  if (r?.status === 'minted') o.save(true)
  else if (r?.status === 'existing') o.save(false)
  else if (r?.status === 'discarded' && await o.getAccessToken().catch(() => null)) o.save(false)
}
