import type { EnsureSessionResult } from './guestSession'

/**
 * The Download tap (LIB-1): the download at once, then the Library save. With no session a guest is
 * minted first, as SessionGate does — a download is intent, and the book must land in the Library
 * (LIB-1a, ADR-014). Nothing waits on the mint (the download already runs), so a slow mint still
 * saves when it answers; a failed one leaves the book downloaded, unsaved. A mint discarded because
 * another session won saves under that session, if one holds a token.
 */
export async function downloadAndSave(o: {
  run: () => unknown
  hasSession: boolean
  ensureSession: () => Promise<EnsureSessionResult>
  getAccessToken: () => Promise<string | null>
  save: () => void
}): Promise<void> {
  void o.run()
  if (o.hasSession) return o.save()
  const r = await o.ensureSession().catch(() => null)
  if (r?.status === 'minted' || r?.status === 'existing') o.save()
  else if (r?.status === 'discarded' && await o.getAccessToken().catch(() => null)) o.save()
}
