import { View, Text, StyleSheet } from 'react-native'
import { Image } from 'expo-image'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { getStorageUrl, userBooksApi } from '@textstack/shared'
import type { ContinueReadingPick } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { fonts } from '../../theme/typography'
import { PressableScale } from '../ui/PressableScale'
import { GeneratedCover } from './GeneratedCover'
import { resumeRoute, userBookReadRoute } from '../../lib/bookRoutes'

/**
 * The single largest, topmost thing a returning reader sees.
 *
 * The app's whole value is behind the reader, so the front door's job is to
 * get the user back into the book they were already reading with one tap and
 * no reading of the screen. Everything else on Library — search, tabs, sort,
 * shelves — is for the rarer case where they want a *different* book.
 *
 * It links straight into the reader at the last chapter, not to the book
 * detail page. A detail page is a second decision the user did not ask for.
 */
export function ResumeHero({ pick }: { pick: ContinueReadingPick }) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const router = useRouter()

  const percent = Math.round(pick.percent * 100)

  // An upload with no chapter in its pick is a PDF read in Original layout (`page:<N>`, no
  // chapter). `resumeRoute` can only send that to the detail screen — QA-007's "Continue opens the
  // book, not the reader" — so ask for the chapter list and resolve the page here. Offline or on
  // any failure, the detail screen is still a correct answer.
  const resume = async () => {
    if (pick.type !== 'userbook' || pick.chapterSlug) { router.push(resumeRoute(pick) as never); return }
    try {
      const [book, progress] = await Promise.all([
        userBooksApi.getUserBook(pick.id),
        userBooksApi.getUserBookProgress(pick.id).catch(() => null),
      ])
      router.push(userBookReadRoute(pick.id, progress, book.chapters) as never)
    } catch {
      router.push(resumeRoute(pick) as never)
    }
  }
  const cover = pick.coverPath ? getStorageUrl(pick.coverPath) : null

  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={t('library.resume.a11yResume')
        .replace('{title}', pick.title)
        .replace('{percent}', String(percent))}
      onPress={() => { void resume() }}
      style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
    >
      {cover ? (
        <Image source={cover} style={styles.cover} contentFit="cover" transition={150} />
      ) : (
        <GeneratedCover title={pick.title} style={styles.cover} />
      )}

      <View style={styles.body}>
        <Text style={[styles.title, { color: colors.text }]} numberOfLines={2}>
          {pick.title}
        </Text>
        <Text style={[styles.percent, { color: colors.textSecondary }]}>
          {t('library.resume.percentComplete').replace('{percent}', String(percent))}
        </Text>

        <View style={[styles.track, { backgroundColor: colors.textSecondary + '25' }]}>
          <View style={[styles.fill, { width: `${percent}%`, backgroundColor: colors.primary }]} />
        </View>

        <View style={[styles.cta, { backgroundColor: colors.primary }]}>
          <Ionicons name="play" size={15} color="#fff" />
          {/* Same promise, same condition — see BookList. */}
          <Text style={styles.ctaText}>
            {percent > 0 ? t('library.resume.continue') : t('library.resume.start')}
          </Text>
        </View>
      </View>
    </PressableScale>
  )
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    gap: 14,
    marginHorizontal: 14,
    marginTop: 12,
    marginBottom: 4,
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
  },
  cover: { width: 72, height: 108, borderRadius: 6 },
  body: { flex: 1, justifyContent: 'center', gap: 6 },
  title: { fontFamily: fonts.serifBold, fontSize: 18, lineHeight: 23 },
  percent: { fontFamily: fonts.sans, fontSize: 12 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 2 },
  cta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    alignSelf: 'flex-start',
    marginTop: 4,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 999,
  },
  ctaText: { fontFamily: fonts.sansMedium, fontSize: 14, color: '#fff' },
})
