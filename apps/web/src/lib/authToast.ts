import type { GuestMergeSkipReason } from '@textstack/shared'

/**
 * Which reassurance a completed sign-in has earned — at most one.
 *
 * <p>`merged` ("your progress moved to your account") is shown only when the reader WAS a guest
 * and the server confirms nothing was skipped. `saved` is the older "your reading progress was
 * kept" for a reader who was anonymous (no session at all) — their localStorage progress is
 * flushed after sign-in. A returning reader re-authenticating had nothing at risk: no toast.</p>
 *
 * <p>`merge-skipped` wins over both, and that precedence is the whole point of this function. The
 * server has reported a skipped guest merge since guest sessions shipped, and no client read the
 * field — so a reader whose highlights and progress stayed behind on an abandoned guest row was
 * shown "your progress was kept" all the same. Of all the things to say in that moment, the false
 * reassurance is the worst one, because it is the sentence that stops them looking.</p>
 */
export type AuthToast = 'merged' | 'saved' | 'merge-skipped' | null

export function authToastFor(
  prev: { isGuest?: boolean } | null,
  guestMergeSkipped: GuestMergeSkipReason | null | undefined,
): AuthToast {
  if (guestMergeSkipped) return 'merge-skipped'
  if (prev === null) return 'saved'
  return prev.isGuest ? 'merged' : null
}
