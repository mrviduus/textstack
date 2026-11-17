/**
 * `@textstack/shared`'s `readingTrackingApi` with M5's gate (#1031): stats, daily, pace, goals,
 * achievements and per-book stats have no V2 storage; their routes answer 410 on V2, so each read is
 * refused (`refuseOnV2`, after the probe) before any request. Sessions pass through unchanged.
 */
import { readingTrackingApi as legacy } from '@textstack/shared'
import { refusedOnV2 } from './v2'

export const readingTrackingApi = {
  ...legacy,
  getStats: refusedOnV2('readingStats', legacy.getStats),
  getDailyStats: refusedOnV2('readingStats', legacy.getDailyStats),
  getReadingPace: refusedOnV2('readingStats', legacy.getReadingPace),
  getGoals: refusedOnV2('goals', legacy.getGoals),
  getAchievements: refusedOnV2('achievements', legacy.getAchievements),
  getBookStats: refusedOnV2('bookStats', legacy.getBookStats),
}
