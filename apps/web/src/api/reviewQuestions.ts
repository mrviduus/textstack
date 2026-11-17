import { authFetch } from './client'
import { refuseOnV2 } from './v2'
import type { AnswerReviewQuestionResponse, DueReviewQuestions, ReviewSelfAssessment } from '@textstack/shared'

/** Chapter-review self-check questions — their own SRS queue (chapter-review.md §11). */
export async function getDueReviewQuestions(limit = 20): Promise<DueReviewQuestions> {
  await refuseOnV2('chapterReview')
  return authFetch<DueReviewQuestions>(`/me/review-questions/due?limit=${limit}`)
}

export function answerReviewQuestion(id: string, selfAssessment: ReviewSelfAssessment): Promise<AnswerReviewQuestionResponse> {
  return authFetch<AnswerReviewQuestionResponse>(`/me/review-questions/${encodeURIComponent(id)}/answer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selfAssessment }),
  })
}
