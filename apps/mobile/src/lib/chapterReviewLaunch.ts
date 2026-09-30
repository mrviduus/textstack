/**
 * Mobile glue for "Review chapter" (docs/05-features/chapter-review.md §12). The decisions —
 * which chat opens, what the brief says — are pure and live in `@textstack/shared`
 * (`lib/chapterReview.ts`); this file only remembers the reader's Claude/ChatGPT pick on this device
 * and builds the summary screen's route.
 */
import AsyncStorage from '@react-native-async-storage/async-storage'
import { REVIEW_ASSISTANT_KEY, parseAssistant, type Assistant } from '@textstack/shared'

export async function loadReviewAssistant(): Promise<Assistant | null> {
  try {
    return parseAssistant(await AsyncStorage.getItem(REVIEW_ASSISTANT_KEY))
  } catch {
    return null
  }
}

export async function saveReviewAssistant(assistant: Assistant): Promise<void> {
  try {
    await AsyncStorage.setItem(REVIEW_ASSISTANT_KEY, assistant)
  } catch {
    // Not remembered → the menu shows again next time. Mildest possible failure.
  }
}

export type ReviewBookRef = { userBookId: string } | { editionId: string; slug: string }

/** Params for `app/chapter-review.tsx`. Catalog books carry the slug too: the book is fetched by it. */
export function chapterReviewRoute(book: ReviewBookRef, chapterSlug: string) {
  return {
    pathname: '/chapter-review' as const,
    params: 'userBookId' in book
      ? { userBookId: book.userBookId, chapterSlug }
      : { editionId: book.editionId, slug: book.slug, chapterSlug },
  }
}
