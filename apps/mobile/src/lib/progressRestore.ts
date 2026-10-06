/**
 * Reopening a book: the device answers first, the server second.
 *
 * The reading path waits for neither a token nor a network (CLAUDE.md), so a chapter always
 * opens from the local record. The server is asked in the background, and its answer can only
 * ADD something: a position another device recorded later than the one this chapter opened from.
 * These are the pure decisions behind that; `progressRestoreOrder.test.ts` pins the ordering.
 */

export {
  serverProvablyNewer,
  trustedLocalStamp,
  decideNewerPosition,
  readerMovedSince,
  REFLOW_MOVE_TOLERANCE_PX,
  MAX_CLIENT_SKEW_MS,
} from '@textstack/shared'
export type { NewerPositionAction } from '@textstack/shared'

/**
 * The app came back to the screen (H3). A phone left open on a chapter is a reopen too: another
 * device may have read on since, and only the open used to ask — so the first scroll here wrote
 * this phone's stale place over it.
 */
export function returnedToForeground(prev: string, next: string): boolean {
  return prev !== 'active' && next === 'active'
}

