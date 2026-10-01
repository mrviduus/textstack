import type { AchievementDto } from '../../api/readingTracking'
import { useTranslation } from '../../hooks/useTranslation'
import { ACHIEVEMENTS } from '@textstack/shared'

interface Props {
  achievements: AchievementDto[]
}

export function StatsAchievementsTab({ achievements }: Props) {
  const { t } = useTranslation()
  const unlockedCodes = new Set(achievements.map(a => a.code))

  return (
    <section className="stats-section">
      <h2>{t('stats.achievements')}</h2>
      <div className="stats-achievements">
        {Object.entries(ACHIEVEMENTS).map(([code, def]) => {
          const unlocked = unlockedCodes.has(code)
          const achievement = achievements.find(a => a.code === code)
          return (
            <div key={code} className={`stats-achievement ${unlocked ? 'stats-achievement--unlocked' : ''}`}>
              <div className="stats-achievement__icon">{def.emoji}</div>
              <div className="stats-achievement__info">
                <div className="stats-achievement__name">{def.name}</div>
                <div className="stats-achievement__desc">{def.description}</div>
                {unlocked && achievement && (
                  <div className="stats-achievement__date">
                    {new Date(achievement.unlockedAt).toLocaleDateString()}
                  </div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}
