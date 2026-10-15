import { describe, it, expect } from 'vitest'
import { exerciseBadgeColor } from './agents'

// The tutor logic itself (buildPlanCard, buildQueue, …) is shared and tested in
// packages/shared/src/api/tutor.test.ts. Only the RN colour helper lives here.

describe('exerciseBadgeColor', () => {
  const palette = { recognition: '#a', recall: '#b', context: '#c', fallback: '#z' }

  it('maps known types to their accent', () => {
    expect(exerciseBadgeColor('recognition', palette)).toBe('#a')
    expect(exerciseBadgeColor('recall', palette)).toBe('#b')
    expect(exerciseBadgeColor('context', palette)).toBe('#c')
  })

  it('maps unknown types to the fallback', () => {
    expect(exerciseBadgeColor('???', palette)).toBe('#z')
  })
})
