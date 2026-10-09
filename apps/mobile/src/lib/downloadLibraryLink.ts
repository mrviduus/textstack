import type { EnsureSessionResult } from './guestSession'
import { READER_SESSION_GATE_TIMEOUT_MS } from './readerSessionGate'
import { withDeadline } from './deadline'

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
 * (LIB-1a, ADR-014). A failed or slow mint (same 3 s deadline) still downloads, unsaved.
 * `save(true)` = a guest minted just now, whose Library is known to be empty.
 */
export async function downloadAndSave(o: {
  run: () => unknown
  hasSession: boolean
  ensureSession: () => Promise<EnsureSessionResult>
  save: (freshGuest: boolean) => void
}): Promise<void> {
  void o.run()
  if (o.hasSession) return o.save(false)
  const r = await withDeadline(o.ensureSession(), READER_SESSION_GATE_TIMEOUT_MS).catch(() => null)
  if (r?.status === 'minted') o.save(true)
  else if (r?.status === 'existing') o.save(false)
}
