/**
 * `@textstack/shared`'s `highlightsApi` with M5's gate (#1031): highlight review has no V2 storage; its
 * route answers 410 on V2, so the read is refused (`refuseOnV2`, after the probe) before any request.
 */
import { highlightsApi as legacy } from '@textstack/shared'
import { refusedOnV2 } from './v2'

export const highlightsApi = {
  ...legacy,
  getHighlightsForReview: refusedOnV2('highlightReview', legacy.getHighlightsForReview),
}
