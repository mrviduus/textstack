// The mobile Tutor ("Smart session") client: everything but the RN colour helper lives in
// @textstack/shared (api/tutor.ts), the same module the web uses.
export {
  startTutorSession,
  sendTutorAnswer,
  sendTutorFeedback,
  buildPlanCard,
  buildQueue,
  isSessionComplete,
  exerciseLabel,
} from '@textstack/shared'
export type { TutorPlanItem, TutorSessionResponse, TutorFeedbackResult } from '@textstack/shared'

/** Known exercise types map to a themed accent color; unknown types get the neutral fallback. */
export function exerciseBadgeColor(
  exerciseType: string,
  palette: { recognition: string; recall: string; context: string; fallback: string },
): string {
  switch (exerciseType) {
    case 'recognition':
      return palette.recognition
    case 'recall':
      return palette.recall
    case 'context':
      return palette.context
    default:
      return palette.fallback
  }
}
