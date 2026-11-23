/**
 * ADR-033 P3 on the device: after an open, the server's copy of this very file gets the page's TOC when it has none.
 * The local library keeps no `hasToc`, so the server is asked (one GET), and only for a book whose server file is
 * these bytes. Never throws: offline, signed out or refused, nothing is sent and a later open tries again.
 */
import { syncApi, syncTocIfMissing } from '@textstack/shared'

/** The book these bytes are here, its file only when it is the server's current one (localLibrary `serverBookOf`). */
type ServerBookOf = (sha256: string) => Promise<{ bookId: string; fileId: string | null } | null>

export async function syncOpenedToc(sha256: string, serverBookOf: ServerBookOf, toc: () => Promise<unknown>): Promise<boolean> {
  try {
    const ids = await serverBookOf(sha256)
    if (!ids?.fileId) return false
    const file = (await syncApi.findBySha256(sha256))?.currentFile
    if (file?.id !== ids.fileId) return false
    return await syncTocIfMissing(ids.bookId, ids.fileId, toc, file.hasToc)
  } catch {
    return false
  }
}
