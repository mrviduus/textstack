import { KNOWN_EXERCISE_TYPES } from '@textstack/shared'

/** Known types map to a styled badge variant; unknown (LLM-emitted) types get a neutral default. */
export function exerciseBadgeClass(exerciseType: string): string {
  const variant = KNOWN_EXERCISE_TYPES.has(exerciseType) ? exerciseType : 'default'
  return `tutor-badge tutor-badge--${variant}`
}
