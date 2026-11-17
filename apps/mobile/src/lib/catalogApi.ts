/**
 * `@textstack/shared`'s catalog shelf (`libraryApi`) and catalog progress (`readingProgressApi`) with
 * M5's gate (#1374): `/me/library` and `/me/progress` answer 410 on V2 (the catalog retires), so each
 * call is refused (`refuseOnV2('catalog')`, after the probe) before any request.
 */
import { libraryApi as legacyLibrary, readingProgressApi as legacyProgress, ApiError } from '@textstack/shared'
import { refusedOnV2, onV2 } from './v2'
import { userBooksApi } from './userBooksApi'

export const libraryApi = {
  ...legacyLibrary,
  getLibrary: refusedOnV2('catalog', legacyLibrary.getLibrary),
  addToLibrary: refusedOnV2('catalog', legacyLibrary.addToLibrary),
  removeFromLibrary: refusedOnV2('catalog', legacyLibrary.removeFromLibrary),
}

export const readingProgressApi = {
  ...legacyProgress,
  getProgress: refusedOnV2('catalog', legacyProgress.getProgress),
  getAllProgress: refusedOnV2('catalog', legacyProgress.getAllProgress),
  updateProgress: refusedOnV2('catalog', legacyProgress.updateProgress),
  markProgressFinished: refusedOnV2('catalog', legacyProgress.markProgressFinished),
}

/** An optional source: none on V2 (refused), and empty on a failure rather than failing the uploads. */
function optional(e: unknown): [] {
  if (!(e instanceof ApiError && e.status === 410)) console.warn('Library: optional source failed:', e)
  return []
}

/**
 * The Library tab's load: the uploads must answer (their failure is the tab's); the catalog shelf and
 * its progress are optional. The last item is the probe answer `getUserBooks` used (#1193).
 */
export const loadLibraryTab = () => Promise.all([
  libraryApi.getLibrary().catch(optional),
  readingProgressApi.getAllProgress().catch(optional),
  userBooksApi.getUserBooks(),
  onV2(),
])
