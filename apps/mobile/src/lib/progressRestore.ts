/**
 * Reopening a book: the device answers first, the server second.
 *
 * The reading path waits for neither a token nor a network (CLAUDE.md), so a chapter always
 * opens from the local record. The server is asked in the background, and its answer can only
 * ADD something: a position another device recorded later than the one this chapter opened from.
 * These are the pure decisions behind that; `progressRestoreOrder.test.ts` pins the ordering.
 */

/**
 * The server row holds a position recorded on some device AFTER the local record this chapter
 * opened from. Decided on client stamps only (`clientUpdatedAt` vs the local `updatedAt`) —
 * never the row's server-clock `updatedAt`.
 *
 * Stricter than `localProgressWins` on purpose: acting on this MOVES the reader, so it needs
 * proof. A row without a client stamp (older build, mark-as-finished, MCP) is not proof — it is
 * usually this device's own last write — so it moves nobody. No local record at all (a new
 * device) and any server row is newer.
 */
export function serverProvablyNewer(
  local: { updatedAt: number } | null | undefined,
  server: { clientUpdatedAt?: string | null } | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!server) return false
  if (!local) return true
  const ms = server.clientUpdatedAt ? Date.parse(server.clientUpdatedAt) : NaN
  return Number.isFinite(ms) && ms > trustedLocalStamp(local.updatedAt, now)
}

/** Mirrors the server's `ProgressClock.MaxClientSkew`. */
export const MAX_CLIENT_SKEW_MS = 5 * 60_000

/**
 * A local stamp, never later than now + skew (L5) — ProgressClock's clamp, applied on the device.
 *
 * A record written while this phone's clock ran ahead (then corrected, by NTP or by hand) carries
 * a stamp from the future, and every honest position from another device compared "older" than it
 * until real time caught up — hours, or a day, of the other device never being offered. The server
 * bounds that freeze for itself by clamping; this bounds it here the same way.
 */
export function trustedLocalStamp(updatedAt: number, now: number): number {
  return Math.min(updatedAt, now + MAX_CLIENT_SKEW_MS)
}

/**
 * - `adopt`: the local restore has not been applied yet — make the newer position the target.
 * - `move`: applied, and the reader has not moved since — go there silently.
 * - `prompt`: the reader has moved, or the position is in another chapter — ask (one toast).
 *   Another chapter is always asked, never navigated to: a chapter opened from the table of
 *   contents looks exactly like a reopen, and taking a reader out of the chapter they chose is
 *   worse than one tap.
 */
export type NewerPositionAction = 'adopt' | 'move' | 'prompt'

export function decideNewerPosition(o: {
  sameChapter: boolean
  restoreApplied: boolean
  readerMoved: boolean
}): NewerPositionAction {
  if (!o.sameChapter) return 'prompt'
  if (!o.restoreApplied) return 'adopt'
  return o.readerMoved ? 'prompt' : 'move'
}

/**
 * Has the reader moved since the restore settled? `baseline` is the first position reported
 * after it (null: none reported yet → not moved). `tolerance` absorbs layout jitter — pixels for
 * the reflow reader, 0 for PDF pages.
 */
export function readerMovedSince(baseline: number | null, current: number | null, tolerance: number): boolean {
  if (baseline == null || current == null) return false
  return Math.abs(current - baseline) > tolerance
}

/**
 * The app came back to the screen (H3). A phone left open on a chapter is a reopen too: another
 * device may have read on since, and only the open used to ask — so the first scroll here wrote
 * this phone's stale place over it.
 */
export function returnedToForeground(prev: string, next: string): boolean {
  return prev !== 'active' && next === 'active'
}

/** Pixels of scroll that still count as "where the restore put them". */
export const REFLOW_MOVE_TOLERANCE_PX = 48
