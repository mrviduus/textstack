export const REVIEW_BATCH_SIZES = [10, 20, 50] as const
/** Contracts.V2.SyncLimits.MaxWord: applies equally to words and expressions. Never truncate a saved selection. */
export const MAX_VOCABULARY_TEXT = 200
export const DEFAULT_BATCH_SIZE = 10
export type ReviewMode = 'blitz' | 'classic'

// Anti-spiral defaults (Phase 1+). Must mirror backend defaults in
// UserVocabularySettings entity + VocabularyEndpoints.GetSettings.
export const DEFAULT_DAILY_CAP = 15
export const DEFAULT_WEEKLY_BUDGET = 70
export const DAILY_CAP_MIN = 5
export const DAILY_CAP_MAX = 100
export const WEEKLY_BUDGET_MIN = 10
export const WEEKLY_BUDGET_MAX = 500
