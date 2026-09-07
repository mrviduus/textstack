/**
 * Two decisions about a person who has just installed the app, kept out of the
 * screens that render them so they can be read in one place and tested.
 *
 *   1. `decideStartReadingCard` — does Discover show the "start here" card that
 *      says what this app is and drops you into one chapter?
 *   2. `decideReaderExitPrompt` (+ `latchChapterEnd`) — when a reader leaves the
 *      reader, do we ask them for a book of their own?
 *
 * Neither is an onboarding flow, deliberately. There is no carousel, no tour,
 * no level picker, and no analytics in this app that could tell us whether one
 * had worked. One card, and one ask timed to the moment the mechanic has just
 * proved itself.
 *
 * Pure by construction: no React, no AsyncStorage, no clock. `vitest.config.ts`
 * only collects `src/lib/**`, so this is also the only shape of these rules
 * that can be covered at all — everything downstream (the card, the overlay,
 * the back handler) is held by review and by an on-device pass.
 */

// ---------------------------------------------------------------------------
// 1 — the Discover "start here" card
// ---------------------------------------------------------------------------

/**
 * Below this fraction a locally-cached progress row is not evidence of reading.
 *
 * The reader flushes progress on unmount whether or not the page moved, so
 * opening a chapter and immediately backing out writes a perfectly valid row at
 * `percent: 0`. Counting rows would therefore hide the card from someone who
 * has read nothing at all — which is precisely the person it exists for. Only a
 * row that MOVED counts.
 *
 * 2% of a chapter is roughly one flick of the thumb; small enough that a real
 * reader clears it in seconds, large enough that a restore-to-top rounding
 * wobble does not.
 */
export const READ_SOMETHING_MIN_FRACTION = 0.02

export interface StartReadingSignals {
  /**
   * False until the AsyncStorage reads have answered. The card must not flash
   * in and then vanish for someone with a shelf full of books, so "not yet
   * known" is a distinct answer from "nothing read".
   */
  loaded: boolean
  /**
   * Every reading fraction this device has cached, catalog books and uploads
   * together (`getAllLocalProgress` + `getAllUserBookLocalProgress`).
   *
   * Local, not server, on purpose. This runs on the app's hottest screen, it
   * has to answer offline and before the session settles, and the question is
   * about this person on this device. The cost is that a returning reader who
   * reinstalls, or signs out (which wipes these rows), is shown the card once
   * more — one card offering a free chapter, which is a cheaper mistake than a
   * network round-trip on every Discover mount.
   */
  progressFractions: number[]
}

export type StartReadingDecision =
  | { show: true }
  /** Storage has not answered yet — render nothing rather than guess. */
  | { show: false; reason: 'unknown' }
  /** They have read something here. The card has done its job; get out of the way. */
  | { show: false; reason: 'already-reading' }

export function decideStartReadingCard(signals: StartReadingSignals): StartReadingDecision {
  if (!signals.loaded) return { show: false, reason: 'unknown' }
  const hasRead = signals.progressFractions.some(
    f => typeof f === 'number' && Number.isFinite(f) && f >= READ_SOMETHING_MIN_FRACTION,
  )
  return hasRead ? { show: false, reason: 'already-reading' } : { show: true }
}

// ---------------------------------------------------------------------------
// 2 — the "bring your own book" ask
// ---------------------------------------------------------------------------

/**
 * One-shot flag for the ask. Mirrors `onboarding.readerTapHint.seen`, the
 * convention already in `ReaderTapCoachmark`.
 *
 * A new flag, and the brief says not to add one if an existing signal answers
 * the question. None does: the trigger below (saved a word, finished a chapter,
 * reading someone else's book) is true of every good reading session forever,
 * so without a written mark the ask would fire on every exit for the rest of
 * the install. Nothing else in the app records "we have made this ask".
 */
export const OWN_BOOK_ASK_SEEN_KEY = 'onboarding.ownBookAsk.seen'

/**
 * How far into a chapter counts as having finished it.
 *
 * Not 1.0: the last screenful of a chapter is a heading and a page break, and
 * infinite scroll starts fetching the next chapter before the current one's
 * bottom is reached, so a reader who is done frequently never reports 100%.
 */
export const CHAPTER_END_PROGRESS = 0.85

/**
 * Latch "this session got to the end of a chapter", folded once per progress
 * message.
 *
 * Latched, not sampled at exit, for two reasons. The reader often scrolls back
 * up before leaving, so the exit snapshot understates where they got. And the
 * mobile reader appends the next chapter inline when you approach the bottom
 * (`readerHtml.ts` → `requestNextChapter`), which resets the within-chapter
 * fraction to near zero the moment you cross the boundary — so "finished a
 * chapter" is also true whenever the chapter under the viewport is no longer
 * the one the route opened.
 *
 * Monotonic: once true it stays true for the session.
 */
export function latchChapterEnd(
  previous: boolean,
  event: { chapterProgress: number; visibleChapterSlug: string | null; openedChapterSlug: string },
): boolean {
  if (previous) return true
  if (event.visibleChapterSlug !== null && event.visibleChapterSlug !== event.openedChapterSlug) return true
  return Number.isFinite(event.chapterProgress) && event.chapterProgress >= CHAPTER_END_PROGRESS
}

export type ReaderExitPrompt =
  /** Leave immediately, as the reader has always done. */
  | 'none'
  /** The existing "{n} words saved → Review now / Later" summary. */
  | 'review-words'
  /** Ask them to bring a book of their own. */
  | 'own-book'

export interface ReaderExitInput {
  /** Words saved to vocabulary during this reading session. */
  sessionWordCount: number
  /** Whose book this is. `userbook` means they already brought one. */
  sourceKind: 'edition' | 'userbook'
  /** `latchChapterEnd` result for this session. */
  finishedChapter: boolean
  /** The one-shot flag above. Treat an unread flag as `true` — never ask twice. */
  ownBookAskSeen: boolean
}

/**
 * What to show when the reader leaves.
 *
 * The order encodes the product rule. The ask has to be EARNED by the mechanic,
 * so a session with no saved word gets nothing at all — same as today. It is
 * pointless for someone already reading their own upload. It happens once. And
 * it waits for the end of a chapter, because that is where a person is finished
 * rather than interrupted, and where they have just felt what the app does.
 *
 * A session that saved words but bailed three paragraphs in still gets the
 * vocabulary summary — that path is unchanged, and the ask never costs it more
 * than the single session in which the ask replaces it.
 */
export function decideReaderExitPrompt(input: ReaderExitInput): ReaderExitPrompt {
  if (input.sessionWordCount <= 0) return 'none'
  if (input.sourceKind === 'userbook') return 'review-words'
  if (input.ownBookAskSeen) return 'review-words'
  if (!input.finishedChapter) return 'review-words'
  return 'own-book'
}

/**
 * Should Android's hardware back be swallowed so the ask can be shown?
 *
 * It has to be, or the ask never happens on the primary platform: `exit()` is
 * wired only to the chevron in the reader's top bar, and the system back button
 * pops the screen without consulting it. (The existing exit summary has always
 * had this hole; this does not widen it — interception is limited to the one
 * prompt that is one-shot per install.)
 *
 * The trap risk is the reason this is a function and not an inline `&&`: we
 * return `true` — "handled, do not pop" — only when the very same decision that
 * `exit()` will make says a prompt is coming, and never while one is already on
 * screen. So the second press always leaves.
 */
export function shouldInterceptReaderBack(input: {
  /** A prompt overlay is already visible. */
  promptVisible: boolean
  /**
   * A sheet, drawer or selection toolbar is open. Back belongs to whatever is
   * on top; today it pops the whole screen, which is a separate bug and not one
   * to fix by stealing the press for an unrelated card.
   */
  otherOverlayOpen: boolean
  /** What `decideReaderExitPrompt` would answer right now. */
  prompt: ReaderExitPrompt
}): boolean {
  if (input.promptVisible) return false
  if (input.otherOverlayOpen) return false
  return input.prompt === 'own-book'
}
