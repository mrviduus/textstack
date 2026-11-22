import { createVocabulary } from '@textstack/shared'
import { v2Book, v2Store } from './v2'

// Vocabulary: the shared V2 vocabulary (one copy for web and mobile) with the
// browser's ids, the last library pull's files and this tab's revision cache.
const {
  saveWord: saveV2Word, getWords: getV2Words, getReaderVocab: getV2ReaderVocab, deleteWord: deleteV2Word, updateWord: updateV2Word,
  getReviewQueue: getV2ReviewQueue, submitReview: submitV2Review, restoreWord: restoreV2Word, deleteAllWords: deleteAllV2Words,
} = createVocabulary({
  newId: () => crypto.randomUUID(),
  fileIdOf: async (bookId) => (await v2Book(bookId)).currentFile?.id ?? null,
  cards: v2Store.cards,
  epoch: () => v2Store.epoch,
})

// --- Types ---

export interface VocabWordDto {
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

export interface SaveWordRequest {
  word: string
  language: string
  translation?: string | null
  definition?: string | null
  editionId?: string | null
  chapterId?: string | null
  userBookId?: string | null
  sentence?: string | null
  bookTitle?: string | null
  nativeLanguage?: string | null
}

export interface UpdateWordRequest {
  translation?: string | null
  definition?: string | null
  /** TR-2: an automatic fill — the server writes only when no translation is stored. */
  onlyIfEmpty?: boolean
}

export interface ReviewCardDto {
  wordId: string
  word: string
  translation: string | null
  definition: string | null
  /** 'flashcard': a V2 card (no distractors, no blanked sentence). */
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

export interface WeeklyProgressDto {
  used: number
  budget: number
  remaining: number
  resetAt: string
}

export interface ReviewQueueResponse {
  cards: ReviewCardDto[]
  totalDue: number
  weeklyProgress: WeeklyProgressDto | null
}

export interface VocabSettingsDto {
  dailyNewCap: number
  weeklyReviewBudget: number
  frequencyFilterEnabled: boolean
  clusteringEnabled: boolean
  autoRetireEnabled: boolean
}

export type SelfAssessment = 'forgot' | 'almost' | 'knew'

export interface SubmitReviewRequest {
  wordId: string
  isCorrect: boolean
  responseTimeMs: number
  selfAssessment?: SelfAssessment
  isPractice?: boolean
}

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

export interface DailyCapDto {
  used: number
  cap: number
  remaining: number
}

export interface VocabStatsDto {
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

/** 'deleted' (V2): the reader deleted this word earlier; `word` is the tombstone, restore is offered. */
export type SaveWordOutcome = 'srs' | 'pending' | 'lookup' | 'lookup_pending' | 'already_saved' | 'deleted'

export interface SaveWordResponse {
  outcome: SaveWordOutcome
  word: VocabWordDto | null
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

export interface WordLookupListResponse {
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

export interface PendingListResponse {
  items: PendingVocabWordDto[]
  dailyUsed: number
  dailyCap: number
  dailyRemaining: number
}

// --- API Functions ---

/** `id`/`operationId`: a queued save replays as the same card and the same operation. */
export function saveWord(request: SaveWordRequest & { id?: string; operationId?: string }): Promise<SaveWordResponse> {
  return saveV2Word(request)
}

export function getWords(params?: {
  stage?: string
  language?: string
  editionId?: string
  search?: string
  sort?: string
  reviewedSince?: string
  limit?: number
  offset?: number
}): Promise<{ total: number; items: VocabWordDto[] }> {
  return getV2Words(params)
}

export function deleteWord(id: string): Promise<void> {
  return deleteV2Word(id)
}

export function deleteAllWords(): Promise<{ deleted: number }> {
  return deleteAllV2Words()
}

export function updateWord(id: string, data: UpdateWordRequest): Promise<VocabWordDto> {
  return updateV2Word(id, data)
}

export function getReviewQueue(limit?: number, includeAll?: boolean): Promise<ReviewQueueResponse> {
  return getV2ReviewQueue(limit, includeAll)
}

/** `reviewMode`, `operationId`: the review row records the mode; a retried answer reuses its id. */
export function submitReview(request: SubmitReviewRequest & { reviewMode?: string; operationId?: string }): Promise<SubmitReviewResponse> {
  return submitV2Review(request)
}

// --- Reader vocab (lightweight) ---

export interface ReaderVocabWordDto {
  id: string
  word: string
  stage: number
  translation?: string
  /** The card's language. */
  language?: string
}

/** Bring back a word deleted earlier (a save answered `deleted`). */
export const restoreWord = (id: string): Promise<VocabWordDto> => restoreV2Word(id)

export function getReaderVocab(): Promise<ReaderVocabWordDto[]> {
  return getV2ReaderVocab()
}
