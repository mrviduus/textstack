export interface AchievementDef {
  emoji: string
  name: string
  description: string
  category: string
}

export const AchievementDefinitions: Record<string, AchievementDef> = {
  // Milestones
  first_session: { emoji: '👣', name: 'First Steps', description: 'Complete your first reading session', category: 'milestone' },
  first_book: { emoji: '📖', name: 'Bookworm', description: 'Finish your first book', category: 'milestone' },
  books_5: { emoji: '📚', name: 'Avid Reader', description: 'Finish 5 books', category: 'milestone' },
  books_10: { emoji: '🏆', name: 'Bibliophile', description: 'Finish 10 books', category: 'milestone' },
  books_25: { emoji: '🎓', name: 'Scholar', description: 'Finish 25 books', category: 'milestone' },
  books_50: { emoji: '👑', name: 'Grandmaster', description: 'Finish 50 books', category: 'milestone' },

  // Streak
  streak_3: { emoji: '🔥', name: 'Getting Started', description: '3-day reading streak', category: 'streak' },
  streak_7: { emoji: '⚡', name: 'Week Warrior', description: '7-day reading streak', category: 'streak' },
  streak_14: { emoji: '💪', name: 'Fortnight Focus', description: '14-day reading streak', category: 'streak' },
  streak_30: { emoji: '🌟', name: 'Monthly Master', description: '30-day reading streak', category: 'streak' },
  streak_100: { emoji: '💎', name: 'Century Club', description: '100-day reading streak', category: 'streak' },

  // Time
  hours_1: { emoji: '⏱️', name: 'One Hour Down', description: 'Read for 1 hour total', category: 'time' },
  hours_10: { emoji: '⏰', name: 'Dedicated', description: 'Read for 10 hours total', category: 'time' },
  hours_50: { emoji: '🕰️', name: 'Committed', description: 'Read for 50 hours total', category: 'time' },
  hours_100: { emoji: '🏅', name: 'Centurion', description: 'Read for 100 hours total', category: 'time' },

  // Special
  early_bird: { emoji: '🌅', name: 'Early Bird', description: 'Read between 5-7 AM', category: 'special' },
  night_owl: { emoji: '🦉', name: 'Night Owl', description: 'Read between 11 PM - 3 AM', category: 'special' },
  speed_reader: { emoji: '⚡', name: 'Speed Reader', description: 'Read over 400 words per minute', category: 'special' },
  marathon: { emoji: '🏃', name: 'Marathon', description: 'Single session over 2 hours', category: 'special' },
}
