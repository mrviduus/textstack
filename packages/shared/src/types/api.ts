export interface BookAuthor {
  id: string
  slug: string
  name: string
  role: string
}

export interface Edition {
  id: string
  slug: string
  title: string
  language: string
  description: string | null
  coverPath: string | null
  publishedAt: string | null
  chapterCount: number
  authors: BookAuthor[]
}

export interface ChapterSummary {
  id: string
  chapterNumber: number
  slug: string
  title: string
  wordCount: number | null
}

export interface ChapterNav {
  slug: string
  title: string
}

export interface Chapter {
  id: string
  chapterNumber: number
  slug: string
  title: string
  html: string
  wordCount: number | null
  prev: ChapterNav | null
  next: ChapterNav | null
}

export interface BookDetail {
  id: string
  slug: string
  title: string
  language: string
  description: string | null
  coverPath: string | null
  publishedAt: string | null
  isPublicDomain: boolean
  seoTitle: string | null
  seoDescription: string | null
  // SEO content blocks
  seoRelevanceText: string | null
  seoThemesJson: string | null
  seoFaqsJson: string | null
  chapters: ChapterSummary[]
  otherEditions: { slug: string; language: string; title: string }[]
  moreByAuthor: { id: string; slug: string; title: string; coverPath: string | null }[]
  authors: BookAuthor[]
}

export interface SearchEdition {
  id: string
  slug: string
  title: string
  language: string
  authors: string | null
  coverPath: string | null
}

export interface SearchResult {
  chapterId: string
  chapterSlug: string | null
  chapterTitle: string | null
  chapterNumber: number
  edition: SearchEdition
  highlights: string[] | null
}

export interface Suggestion {
  text: string
  slug: string
  authors: string | null
  coverPath: string | null
  score: number
}

export interface Author {
  id: string
  slug: string
  name: string
  bio: string | null
  photoPath: string | null
  bookCount: number
}

export interface AuthorDetail extends Author {
  seoRelevanceText: string | null
  seoThemesJson: string | null
  seoFaqsJson: string | null
  editions: Edition[]
}

export interface Genre {
  id: string
  slug: string
  name: string
  description: string | null
  bookCount: number
}

export interface GenreDetail extends Genre {
  editions: Edition[]
}

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

export interface AuthResponse {
  user: UserDto
}

export interface MobileAuthResponse {
  user: UserDto
  accessToken: string
  refreshToken: string
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
}

// Bookmarks
export interface BookmarkDto {
  id: string
  editionId: string
  chapterId: string
  locator: string
  title: string | null
  createdAt: string
  /** Derived from locator for convenience — not from backend */
  chapterSlug?: string
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

export interface DailyCapDto {
  used: number
  cap: number
  remaining: number
}

export interface VocabularyStatsDto {
  totalWords: number
  byStage: {
    new: number
    recognition: number
    recall: number
    context: number
    mastered: number
  }
  dueNow: number
  retiredCount: number
  pendingCount: number
  lookupCount: number
  clusterCount: number
  dailyCap: DailyCapDto
  weeklyProgress: WeeklyProgressDto
  reviewedToday: number
  correctRateToday: number
  srsReviewedToday: number
  srsCorrectRateToday: number
  practicedToday: number
  practiceCorrectRateToday: number
  totalReviews: number
  overallCorrectRate: number
  streak: number
  wordsByBook: { editionId: string | null; userBookId: string | null; bookTitle: string; count: number }[]
}

export type SaveWordOutcome = 'srs' | 'pending' | 'lookup' | 'lookup_pending' | 'already_saved'

export interface SaveWordResponseDto {
  outcome: SaveWordOutcome
  word: VocabularyWordDto | null
  pendingId: string | null
  lookupId: string | null
  tapsRemaining: number | null
  reason: string | null
}

export interface WordLookupDto {
  id: string
  word: string
  language: string
  zipfRank: number | null
  tapCount: number
  sentence: string | null
  bookTitle: string | null
  editionId: string | null
  chapterId: string | null
  userBookId: string | null
  lastTranslation: string | null
  firstTappedAt: string
  lastTappedAt: string
}

export interface WordLookupListResponseDto {
  items: WordLookupDto[]
  total: number
}

export interface PendingVocabWordDto {
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
  priority: number
  source: string
  createdAt: string
}

export interface PendingListResponseDto {
  items: PendingVocabWordDto[]
  dailyUsed: number
  dailyCap: number
  dailyRemaining: number
}

export interface VocabSettingsDto {
  dailyNewCap: number
  weeklyReviewBudget: number
  frequencyFilterEnabled: boolean
  clusteringEnabled: boolean
  autoRetireEnabled: boolean
  /** Speak the word when a review card appears. */
  autoSpeakCards: boolean
}

export interface VocabDailyStatDto {
  date: string
  wordsAdded: number
  reviewCount: number
  correctCount: number
  practiceCount: number
  srsCount: number
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
   * `'context'` also cannot arrive over the wire. `SrsEngine.GetReviewMode` can
   * return it for stages 3-4 with a sentence, but `ReviewCardBuilder` builds MC
   * options for those cards and rewrites the mode to `'multiple_choice'` on the
   * way out ("Context cloze uses MC UI"). Typed recall was removed; the branch
   * that would have used the distinction went with it. Both clients still *write*
   * `'context'` locally when the tutor synthesizes a flashcard from a plan item
   * (`buildPlanCard`), purely because the field is required.
   *
   * Left in place deliberately: removing it is a code change across two DTO
   * copies (this one and `apps/web/src/api/vocabulary.ts`), the server contract
   * and the projections, and it belongs in its own slice. Do not build on it.
   */
  reviewMode: 'multiple_choice' | 'context'
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

export interface WordClusterDto {
  id: string
  title: string
  theme: string | null
  editionId: string | null
  userBookId: string | null
  bookTitle: string | null
  memberCount: number
  cohesionScore: number
  isConfirmed: boolean
  createdAt: string
}

export interface ClusterListResponseDto {
  items: WordClusterDto[]
}

export interface ClusterBonusResponse {
  clusterId: string
  title: string
  cards: ReviewCardDto[]
}

// Reading Stats
export interface ReadingStatsDto {
  totalSeconds: number
  totalWords: number
  booksFinished: number
  currentStreak: number
  longestStreak: number
  todaySeconds: number
  weekSeconds: number
  monthSeconds: number
  avgDailyMinutes: number
  avgWordsPerMinute: number
  dailyGoal: { target: number; today: number; met: boolean } | null
}

export interface DailyStatDto {
  date: string
  totalSeconds: number
  totalWords: number
  sessionCount: number
}

export interface AchievementDto {
  code: string
  unlockedAt: string
}

export interface GoalDto {
  id: string
  goalType: string
  targetValue: number
  year: number
  streakMinMinutes: number
  updatedAt: string
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
  /** True when the original upload is a PDF → the card can open "Original layout".
   *  Absent on older payloads → false. */
  hasOriginalPdf?: boolean
}

export interface UserBookChapterDto {
  id: string
  slug: string
  title: string
  html: string
  wordCount: number | null
  prev: ChapterNav | null
  next: ChapterNav | null
  /** 1-based PDF page where this chapter starts. Null for EPUBs / unknown. */
  sourceStartPage?: number | null
}
