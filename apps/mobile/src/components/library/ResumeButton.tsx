import { Text, StyleSheet, TouchableOpacity } from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import type { ContinueReadingPick } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { fonts } from '../../theme/typography'
import { resumeRoute } from '../../lib/bookRoutes'

/** One instance for the whole Library: Continue opens the reader, which needs no network (#1522). */
export function useResume() {
  const router = useRouter()
  return (pick: ContinueReadingPick) => router.push(resumeRoute(pick) as never)
}

/**
 * Continue on a Library row or grid cover. The Library used to open on a hero card with
 * the same book as row one; the row now carries the action itself.
 *
 * It links straight into the reader at the last chapter, not to the book
 * detail page. A detail page is a second decision the user did not ask for.
 * `filled` marks the first visible Continue; the rest are quiet outlines. `compact` (grid cover badge) is always solid, since an outline does not read over a cover.
 */
export function ResumeButton({ pick, filled: wantFilled, compact, onResume }: {
  pick: ContinueReadingPick
  filled: boolean
  compact?: boolean
  onResume: (pick: ContinueReadingPick) => void
}) {
  const filled = wantFilled || !!compact
  const { colors } = useTheme()
  const { t } = useLanguage()

  const percent = Math.round(pick.percent * 100)
  const fg = filled ? '#fff' : colors.primary

  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={t('library.resume.a11yResume')
        .replace('{title}', pick.title)
        .replace('{percent}', String(percent))}
      hitSlop={8}
      onPress={() => onResume(pick)}
      style={[styles.cta, compact && styles.compact, filled ? { backgroundColor: colors.primary } : { borderWidth: 1, borderColor: colors.primary }]}
    >
      <Ionicons name="play" size={12} color={fg} />
      {!compact && <Text style={[styles.ctaText, { color: fg }]}>{t('library.resume.continue')}</Text>}
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 8,
  },
  // Grid cover badge: icon only, solid so it reads over any cover.
  compact: { width: 30, height: 30, justifyContent: 'center', paddingVertical: 0, paddingHorizontal: 0, borderRadius: 15 },
  ctaText: { fontFamily: fonts.sansMedium, fontSize: 13 },
})
