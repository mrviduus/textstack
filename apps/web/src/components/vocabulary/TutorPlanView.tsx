import { exerciseLabel, type TutorPlanItem } from '@textstack/shared'
import { exerciseBadgeClass } from './tutorLabels'

interface Props {
  rationale: string
  plan: TutorPlanItem[]
  readingNudge: string
  adjusted: boolean
  t: (key: string) => string
  onStart: () => void
}

// The showcase: surfaces the tutor's reasoning as a deliberate "here's your plan and why" view — the visible
// reasoning is the point, not debug text.
export function TutorPlanView({ rationale, plan, readingNudge, adjusted, t, onStart }: Props) {
  return (
    <div className="tutor-plan">
      <div className="tutor-plan__rationale">
        <span className="tutor-plan__rationale-label">
          {adjusted ? t('tutor.plan.adjustedLabel') : t('tutor.plan.rationaleLabel')}
        </span>
        <p className="tutor-plan__rationale-text tutor-clamp tutor-clamp--4">{rationale}</p>
      </div>

      <ol className="tutor-plan__list">
        {plan.map((item, i) => (
          <li key={item.wordId} className="tutor-plan__item">
            <span className="tutor-plan__item-index">{i + 1}</span>
            <div className="tutor-plan__item-body">
              <div className="tutor-plan__item-head">
                <span className="tutor-plan__item-word">{item.word}</span>
                <span className={exerciseBadgeClass(item.exerciseType)}>
                  {exerciseLabel(item.exerciseType, t)}
                </span>
                <span className="tutor-plan__item-difficulty tutor-clamp tutor-clamp--1">{item.difficulty}</span>
              </div>
              <p className="tutor-plan__item-why tutor-clamp tutor-clamp--3">{item.why}</p>
            </div>
          </li>
        ))}
      </ol>

      {readingNudge && (
        <div className="tutor-plan__nudge">
          <span className="tutor-plan__nudge-icon" aria-hidden>📖</span>
          <p className="tutor-plan__nudge-text tutor-clamp tutor-clamp--3">{readingNudge}</p>
        </div>
      )}

      <button className="tutor-plan__start" onClick={onStart}>
        {t('tutor.plan.start')}
      </button>
    </div>
  )
}
