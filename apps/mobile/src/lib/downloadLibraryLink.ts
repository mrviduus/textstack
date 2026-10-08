import type { EnsureSessionResult } from './guestSession'
import { READER_SESSION_GATE_TIMEOUT_MS } from './readerSessionGate'

/**
 * LIB-1: Download adds the book to the Library; cancelling a download that added it takes it back
 * out; a book saved by hand stays. "Added by download" is remembered only when the Library state was
 * known to be not-in-library and the add succeeded — never remove what we are not sure we added.
 */
export function downloadLibraryLink() {
  let added: Promise<boolean> | null = null
  return {
    start(state: 'in' | 'out' | 'unknown', add: () => Promise<boolean>) {
      if (state === 'in') return
      const p = add()
      if (state === 'out') added = p
    },
    /** Waits for the in-flight add first, so the DELETE never overtakes its POST. */
    async cancel(remove: () => unknown) {
      const p = added
      added = null
      if (p && await p) await remove()
    },
    /** A hand Save/remove, or that download finishing or being removed, ends the link. */
    forget() { added = null },
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
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<null>(r => { timer = setTimeout(() => r(null), READER_SESSION_GATE_TIMEOUT_MS) })
  const r = await Promise.race([o.ensureSession().catch(() => null), deadline]).finally(() => clearTimeout(timer))
  if (r?.status === 'minted') o.save(true)
  else if (r?.status === 'existing') o.save(false)
}
