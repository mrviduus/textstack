/**
 * `@textstack/shared`'s catalog shelf (`libraryApi`) and catalog progress (`readingProgressApi`) with
 * M5's gate (#1374): `/me/library` and `/me/progress` answer 410 on V2 (the catalog retires), so each
 * call is refused (`refuseOnV2('catalog')`, after the probe) before any request.
 */
import { libraryApi as legacyLibrary, readingProgressApi as legacyProgress } from '@textstack/shared'
import { refusedOnV2, nullIfRefused, onV2 } from './v2'
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

/**
 * The Library tab's load. On V2 the catalog shelf and its progress are none (refused, empty); any other
 * failure fails the load, so the tab's error and offline branches run. The last item is the probe
 * answer `getUserBooks` used (#1193).
 */
export const loadLibraryTab = () => Promise.all([
  libraryApi.getLibrary().catch((e) => nullIfRefused(e) ?? []),
  readingProgressApi.getAllProgress().catch((e) => nullIfRefused(e) ?? []),
  userBooksApi.getUserBooks(),
  onV2(),
])
