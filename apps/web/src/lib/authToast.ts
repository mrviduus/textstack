import type { GuestMergeSkipReason } from '@textstack/shared'

/**
 * Which reassurance a completed sign-in has earned — at most one.
 *
 * <p>`success` is the existing "your reading progress and saved words were kept". It is shown only
 * when the reader actually crossed from anonymous/guest into an account; a returning reader
 * re-authenticating had nothing at risk and needs no reassurance.</p>
 *
 * <p>`merge-skipped` wins over it, and that precedence is the whole point of this function. The
 * server has reported a skipped guest merge since guest sessions shipped, and no client read the
 * field — so a reader whose highlights and progress stayed behind on an abandoned guest row was
 * shown "your progress was kept" all the same. Of all the things to say in that moment, the false
 * reassurance is the worst one, because it is the sentence that stops them looking.</p>
 */
export type AuthToast = 'success' | 'merge-skipped' | null

export function authToastFor(
  wasGuestOrAnonymous: boolean,
  guestMergeSkipped: GuestMergeSkipReason | null | undefined,
): AuthToast {
  if (guestMergeSkipped) return 'merge-skipped'
  return wasGuestOrAnonymous ? 'success' : null
}
