import { authFetch, jsonBody } from './client'
import type { ReadingProgressDto } from '../types/api'
import { PERCENT_UNIT_BOOK } from '../reader/progressPayload'
import { PROGRESS_LOCATOR_END, PROGRESS_LOCATOR_START } from '../reader/progressLocators'

export function getProgress(editionId: string) {
  return authFetch<ReadingProgressDto>(`/me/progress/${editionId}`)
}

/**
 * Save a catalog-book reading position.
 *
 * `progress` is BOOK-wide (0..1) — the canonical unit of
 * `ReadingProgress.Percent`. It used to be a chapter fraction from this client
 * and a book fraction from web, into the same column.
 *
 * `scrollOffset` is what makes a cross-device resume land in the right place.
 * This client used to send `{"type":"chapter","slug":…}` and drop the offset
 * entirely, so opening the book on another device resumed at the top of the
 * chapter no matter how far in you were. The `scroll:` form is what every other
 * writer already uses, and `parseScrollLocator` reads it back.
 */
export function updateProgress(
  editionId: string,
  data: { chapterId: string; chapterSlug: string; progress: number; scrollOffset?: number; positionJson?: string },
) {
  const offset = typeof data.scrollOffset === 'number' && Number.isFinite(data.scrollOffset) && data.scrollOffset > 0
    ? Math.floor(data.scrollOffset)
    : 0
  return authFetch<void>(`/me/progress/${editionId}`, jsonBody('PUT', {
    chapterId: data.chapterId,
    locator: `scroll:${data.chapterSlug}:${offset}`,
    // Where the reader is in the TEXT. The locator above is kept for builds that
    // predate this; the server stores them side by side and clears the position
    // whenever a write cannot carry one, so the row can never disagree with itself.
    positionJson: data.positionJson,
    percent: data.progress,
    // Book-wide, and says so. Without the declaration the server keeps whatever
    // it already had — see Application.ReadingTracking.ProgressUnit.
    percentUnit: PERCENT_UNIT_BOOK,
    // Client timestamp for LWW merge on server (UserDataEndpoints.cs:134) and on restore in web.
    // Skips stale overwrites if a newer record already exists on the server.
    updatedAt: new Date().toISOString(),
  }))
}

export async function getAllProgress() {
  const res = await authFetch<{ total: number; items: ReadingProgressDto[] }>('/me/progress')
  return res.items
}

/**
 * Mark a catalog book finished, or put it back at the start.
 *
 * <p>Separate from {@link updateProgress} because it is not a position: marking a book finished says
 * nothing about where in the last chapter the reader is, and this client used to say it anyway —
 * `scroll:<lastSlug>:0`, which reopened the book at the top of its last chapter. Web has always
 * written the sentinel for the same action. Both now write the same thing.</p>
 */
export function markProgressFinished(
  editionId: string,
  data: { chapterId: string; finished: boolean },
) {
  return authFetch<void>(`/me/progress/${editionId}`, jsonBody('PUT', {
    chapterId: data.chapterId,
    locator: data.finished ? PROGRESS_LOCATOR_END : PROGRESS_LOCATOR_START,
    percent: data.finished ? 1 : 0,
    percentUnit: PERCENT_UNIT_BOOK,
    // NO `updatedAt`, deliberately — and web's markAsRead has never sent one either.
    //
    // The server treats it as a last-write-wins guard: a timestamp that is not newer than the
    // stored one makes the whole write a no-op, answered 200 with the row untouched
    // (UserDataEndpoints.UpsertProgress). That guard is for a queued background sync, where an old
    // queued write must not overwrite a fresh one. This is neither queued nor background: the
    // reader just tapped "mark as finished" and the shelf has already flipped optimistically. On a
    // device whose clock runs a minute behind the server — ordinary, and invisible to the reader —
    // the tap did nothing and said it worked.
  }))
}
