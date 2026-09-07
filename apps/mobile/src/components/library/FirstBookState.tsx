import { View, Text, StyleSheet } from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { useAuth } from '../../context/AuthContext'
import { capabilitiesFor } from '../../lib/capabilities'
import { fonts } from '../../theme/typography'
import { PressableScale } from '../ui/PressableScale'

/**
 * What a reader with no books sees on the front door.
 *
 * One primary action, because two equal buttons is a decision and there is
 * nothing to decide here. Which action is primary depends on which one the
 * reader can actually take:
 *
 *   - Anyone with a session can upload — a guest included, since the
 *     2026-09-06 reversal (`lib/capabilities.ts`, ADR-014 §3). Uploading is what
 *     makes the rest of the app do anything for a book they already want to
 *     finish, and "bring your own book" is the product's first claim, so it is
 *     the primary. Catalog underneath.
 *   - A device with no session at all cannot: `POST /me/books/upload` has no
 *     bearer token, and mobile mints a guest only when a book is opened. For
 *     them the catalog is promoted, and it is not a consolation prize — opening
 *     one classic is what mints the session that makes the other branch
 *     available. Upload stays as the link that asks for an account, because a
 *     primary "Upload a book" landing on a sign-in wall would be the same broken
 *     promise the tap-a-word coachmark used to make.
 *
 * The branch moved without this file changing, which was the point of putting
 * the policy in one pure function. Only the reasons above are new.
 *
 * Note the `library.firstBook.guest*` keys now address that second reader, not a
 * guest — the names are older than the policy. Renaming them is a locale-file
 * change with no behaviour in it, deliberately not bundled here.
 *
 * The copy names the tap-a-word loop in both variants, since that is the feature
 * a new reader cannot discover on their own and the reason to read here rather
 * than in any other reader.
 */
export function FirstBookState() {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const { user } = useAuth()
  const router = useRouter()

  const { canUpload } = capabilitiesFor(user)

  const primary = canUpload
    ? { label: t('library.firstBook.upload'), icon: 'add' as const, go: () => router.push('/my-books/upload') }
    : { label: t('library.firstBook.guestBrowse'), icon: 'search' as const, go: () => router.push('/(tabs)/search') }

  const secondary = canUpload
    ? { label: t('library.firstBook.browse'), go: () => router.push('/(tabs)/search') }
    : { label: t('library.firstBook.guestUpload'), go: () => router.push('/(auth)/login') }

  return (
    <View style={styles.wrap}>
      <Ionicons name="book-outline" size={44} color={colors.primary} />
      <Text style={[styles.title, { color: colors.text }]}>{t('library.firstBook.title')}</Text>
      <Text style={[styles.copy, { color: colors.textSecondary }]}>
        {canUpload ? t('library.firstBook.copy') : t('library.firstBook.guestCopy')}
      </Text>

      <PressableScale
        accessibilityRole="button"
        onPress={primary.go}
        style={[styles.cta, { backgroundColor: colors.primary }]}
      >
        <Ionicons name={primary.icon} size={18} color="#fff" />
        <Text style={styles.ctaText}>{primary.label}</Text>
      </PressableScale>

      <PressableScale
        accessibilityRole="button"
        onPress={secondary.go}
        style={styles.secondary}
      >
        <Text style={[styles.secondaryText, { color: colors.textSecondary }]}>
          {secondary.label}
        </Text>
      </PressableScale>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingVertical: 40, paddingHorizontal: 32, gap: 10 },
  title: { fontFamily: fonts.serifBold, fontSize: 20, marginTop: 6 },
  copy: { fontFamily: fonts.sans, fontSize: 13, textAlign: 'center', lineHeight: 20 },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 10,
    paddingHorizontal: 22,
    paddingVertical: 11,
    borderRadius: 999,
  },
  ctaText: { fontFamily: fonts.sansMedium, fontSize: 15, color: '#fff' },
  secondary: { paddingVertical: 8, paddingHorizontal: 12 },
  secondaryText: { fontFamily: fonts.sans, fontSize: 13, textDecorationLine: 'underline' },
})
