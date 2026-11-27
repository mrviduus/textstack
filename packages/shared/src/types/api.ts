import type { MergeMap } from '../api/sync'

// Auth
export interface UserDto {
  id: string
  email: string
  name: string | null
  picture: string | null
  createdAt: string
  isGuest: boolean
  nativeLanguage: string | null
}

/**
 * Why a sign-in completed WITHOUT carrying the reader's pre-sign-in work across.
 *
 * Mirrors `AuthEndpoints.GuestMergeSkipReason`. Null/absent is the ordinary case, and by far the
 * common one. Both values mean the same thing to the reader — what they did before signing in is
 * not in this account — and they differ only for whoever reads the logs.
 */
export type GuestMergeSkipReason = 'invalid_token' | 'merge_conflict'

export interface AuthResponse {
  user: UserDto
  /**
   * Set when the guest merge was abandoned. **Read it**: the server has reported this since guest
   * sessions shipped and no client looked, so a reader whose highlights and progress stayed behind
   * was shown "your progress is saved" — a reassurance that was false exactly when it mattered.
   */
  guestMergeSkipped?: GuestMergeSkipReason | null
}

export interface MobileAuthResponse {
  user: UserDto
  accessToken: string
  refreshToken: string
  /** See {@link AuthResponse.guestMergeSkipped}. */
  guestMergeSkipped?: GuestMergeSkipReason | null
  /** V2 on and a guest merged: the ids that changed (PDD "Guest → account merge"). */
  merge?: MergeMap
}

// Reading Progress (matches backend ReadingProgressDto)
export interface ReadingProgressDto {
  editionId: string
  chapterId: string
  chapterSlug: string | null
  locator: string
  percent: number | null
  updatedAt: string
  /** Non-null once the book is finished. Read this instead of comparing
   *  `percent` against a threshold — editions used to have no completion field,
   *  so four places each picked their own (0.95, 0.95, 1.0, 1.0). */
  completedAt?: string | null
  /** Where the reader is IN THE TEXT, serialised — see `textPosition.ts`.
   *  Prefer it over `locator`: a pixel offset stops being true the moment the
   *  text reflows. Null on rows last written by a build that predates it, and
   *  on every PDF page position. */
  positionJson?: string | null
  /** The CLIENT clock of the write the server kept. Compare a local record's own
   *  stamp with this — never with `updatedAt`, which is the server's clock. Null
   *  when that write carried no timestamp; absent from older servers. See
   *  `localProgressWins`. */
  clientUpdatedAt?: string | null
}

// Vocabulary
export interface VocabularyWordDto {
  id: string
  word: string
  language: string
  translation: string | null
  definition: string | null
  editionId: string | null
  chapterId: string | null
  userBookId: string | null
  sentence: string | null
  bookTitle: string | null
  hint: string | null
  stage: number
  intervalDays: number
  consecutiveCorrect: number
  nextReviewAt: string
  lastReviewedAt: string | null
  totalReviews: number
  correctReviews: number
  createdAt: string
  updatedAt: string
}

export interface WeeklyProgressDto {
  used: number
  budget: number
  remaining: number
  resetAt: string
}

/** 'deleted' (V2): the reader deleted this word earlier; `word` is the tombstone, restore is offered. */
export type SaveWordOutcome = 'srs' | 'pending' | 'lookup' | 'lookup_pending' | 'already_saved' | 'deleted'

export interface SaveWordResponseDto {
  outcome: SaveWordOutcome
  word: VocabularyWordDto | null
  pendingId: string | null
  lookupId: string | null
  tapsRemaining: number | null
  reason: string | null
}

export interface ReviewCardDto {
  wordId: string
  word: string
  translation: string | null
  definition: string | null
  /**
   * Vestigial. **The client owns the review style; this field does not.**
   *
   * No runtime code reads it. Cards render from `options` / `correctOptionIndex` /
   * `blankSentence`; the style a session runs in comes from the client
   * (`apps/mobile/src/lib/reviewMode.ts`, added in #562, and
   * `apps/web/src/pages/VocabularyReviewPage.tsx`), whose `ReviewMode` is
   * `'blitz' | 'classic'` — a different vocabulary that only happens to share the
   * name. Nothing asserts a particular value any more: the tutor's projection
   * test now checks `options` / `blankSentence`, which is what the card is drawn
   * from.
   *
   * The server code that chose a mode (`ReviewCardBuilder`, `GetReviewMode`) is
   * deleted. Both clients still *write*
   * `'context'` locally when the tutor synthesizes a flashcard from a plan item
   * (`buildPlanCard`), purely because the field is required.
   *
   * Left in place deliberately: removing it is a code change across this DTO,
   * the server contract and the projections, and it belongs in its own slice.
   * Do not build on it.
   */
  reviewMode: 'multiple_choice' | 'context' | 'flashcard'
  blankSentence: string | null
  originalSentence: string | null
  bookTitle: string | null
  hint: string | null
  explanation: string | null
  isNew: boolean
  options: string[] | null
  correctOptionIndex: number | null
}

export type SelfAssessment = 'forgot' | 'almost' | 'knew'

export interface SubmitReviewResponse {
  wordId: string
  previousStage: number
  newStage: number
  stageChanged: boolean
  nextIntervalDays: number
  nextReviewAt: string
  totalReviews: number
  correctReviews: number
}

// Reading Stats — `GET /me/v2/stats` (#1366)
export type ReadingStatsPeriod = 'week' | 'month' | 'halfyear' | 'year'

/** One chart bar: a day (week, month) or a calendar month (halfyear, year). Future days are 0. */
export interface ReadingStatsBar {
  /** `YYYY-MM-DD`, the bar's first day in the asked time zone. */
  start: string
  minutes: number
}

/** The period's totals and bars; the streaks are period-independent. Week = Monday..Sunday. */
export interface ReadingStatsDto {
  period: ReadingStatsPeriod
  from: string
  to: string
  minutes: number
  daysRead: number
  currentStreak: number
  bestStreak: number
  bars: ReadingStatsBar[]
}

// Library (matches backend LibraryItemDto)
export interface UserLibraryItem {
  editionId: string
  slug: string
  title: string
  language: string
  coverPath: string | null
  createdAt: string
  author: string | null
}

// User Books
export interface UserBookDto {
  id: string
  title: string | null
  author: string | null
  language: string
  coverPath: string | null
  genre: string | null
  totalWordCount: number | null
  status: string
  chapterCount: number
  createdAt: string
  completedAt: string | null
  errorMessage: string | null
  progressPercent: number | null
  progressUpdatedAt: string | null
  progressChapterSlug: string | null
  /** Where the reader stopped. The list used to carry a percentage and a slug
   *  but no position, so a card could say how far in a reader was and still not
   *  offer to continue from there. `progressPositionJson` is preferred. */
  progressLocator?: string | null
  progressPositionJson?: string | null
  /** Client clock of the kept progress write — same contract as
   *  `ReadingProgressDto.clientUpdatedAt`. */
  progressClientUpdatedAt?: string | null
  /** True when the original upload is a PDF → the card can open "Original layout".
   *  Absent on older payloads → false. */
  hasOriginalPdf?: boolean
}

// ── Chapter review (ADR-016) — `BookInsight.review`; mirrors Contracts/ChapterReview/ChapterReviewDtos.cs ──

export interface ChapterReviewQuestion { prompt: string; answer: string }

export interface ChapterReviewBlock {
  title: string
  problem: string
  rootCause: string
  /** The line to memorize verbatim. */
  rule: string
  /** Ids of the reader's highlights this block covers; a deleted highlight no longer resolves. */
  highlightIds: string[]
  question: ChapterReviewQuestion
}

export interface ChapterReviewThread { id: string; text: string }

export interface ChapterReviewDto {
  methodVersion: number
  /** What the reader remembered, in their words — the no-highlights (audiobook) path. */
  recall: string | null
  blocks: ChapterReviewBlock[]
  applications: string[]
  openThreads: ChapterReviewThread[]
  closedThreadIds: string[]
}
