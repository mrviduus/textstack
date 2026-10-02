import { useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { insightsApi, insightChapterLabel, insightDateLabel, type BookInsight } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { Ionicons } from '@expo/vector-icons'
import { fonts } from '../../theme/typography'
import { Markdown } from '../Markdown'
import { router } from 'expo-router'
import { chapterReviewRoute } from '../../lib/chapterReviewLaunch'

/**
 * "What you've worked out" — the conclusions an outside assistant wrote back into
 * this book over MCP.
 *
 * The return path, and the reason the write-back is worth having: come back to a
 * book a month later and read the twenty lines that matter instead of the four
 * hundred pages. The server orders them — the book-level overview first, then
 * chapters by number — so this renders the list as it arrives.
 *
 * Renders nothing at all when there is nothing yet. An empty state here would be
 * a tutorial for a feature you can only reach by connecting an assistant, and it
 * would sit on every book screen forever for the readers who never do.
 *
 * Markdown goes through the shared `Markdown` renderer:
 * pure JS, theme-tokenised, OTA-safe, and no raw-HTML path — so assistant output
 * is only ever tokenised, never interpreted.
 */
interface Props {
  /** Fetched once by the screen's `useBookReviews` — the same rows feed the
   *  chapter list's "reviewed" marks, so this section does not fetch its own. */
  insights: BookInsight[]
  /** Drop a row the reader removed from the screen's state. */
  onRemoved: (id: string) => void
  /** Exactly one of these. */
  userBookId?: string
  editionId?: string
  /** A catalog book's slug — the review screen fetches the book by it. */
  bookSlug?: string
}

export function BookInsightsSection({ insights, onRemoved, userBookId, editionId, bookSlug }: Props) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  // The id being removed, so the row cannot be double-tapped into two requests.
  const [removing, setRemoving] = useState<string | null>(null)

  // A conclusion filed against the WRONG chapter is never revisited by the assistant — it only ever
  // replaces its own row for the chapter it meant. Removing it is the reader's, and only the
  // reader's: there is no assistant-side delete, by design.
  const remove = async (id: string) => {
    setRemoving(id)
    try {
      await insightsApi.deleteBookInsight(id)
      onRemoved(id)
    } catch {
      // The row stays, which is the honest outcome — it is still on the server.
    } finally {
      setRemoving(null)
    }
  }

  if (insights.length === 0) return null

  return (
    <View style={[styles.section, { borderTopColor: colors.border }]}>
      <Text style={[styles.title, { color: colors.text }]}>{t('library.insights.title')}</Text>
      <Text style={[styles.lead, { color: colors.textSecondary }]}>{t('library.insights.lead')}</Text>

      {insights.map(insight => (
        <View key={insight.id} style={[styles.item, { borderLeftColor: colors.border }]}>
          {/* Which chapter, decided once in the shared package — never the
              number, and falling back to the slug when a re-ingest left the
              title unresolvable. See insightScope.ts for why both matter. */}
          <View style={styles.head}>
            <Text style={[styles.scope, { color: colors.textSecondary }]}>
              {(insightChapterLabel(insight) ?? t('library.insights.wholeBook')).toUpperCase()}
            </Text>
            {/* When it was last written — a конспект is read months later. */}
            {insightDateLabel(insight) ? (
              <Text style={[styles.date, { color: colors.textSecondary }]}>{insightDateLabel(insight)}</Text>
            ) : null}
            <TouchableOpacity
              onPress={() => remove(insight.id)}
              disabled={removing === insight.id}
              accessibilityRole="button"
              accessibilityLabel={t('library.insights.remove')}
              // The tap target the text alone would not give it.
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            >
              <Ionicons
                name="close"
                size={16}
                color={removing === insight.id ? colors.border : colors.textSecondary}
              />
            </TouchableOpacity>
          </View>

          {insight.question ? (
            <Text style={[styles.question, { color: colors.text }]}>{insight.question}</Text>
          ) : null}

          {/* A structured review has its own screen; the Markdown below is its fallback. */}
          {insight.review && insight.chapterSlug && (userBookId || (editionId && bookSlug)) ? (
            <TouchableOpacity
              accessibilityRole="link"
              onPress={() => router.push(chapterReviewRoute(
                userBookId ? { userBookId } : { editionId: editionId!, slug: bookSlug! },
                insight.chapterSlug!,
              ))}
            >
              <Text style={[styles.question, { color: colors.primary }]}>{t('chapterReview.openReview')}</Text>
            </TouchableOpacity>
          ) : null}

          <View style={styles.body}>
            <Markdown text={insight.text} />
          </View>
        </View>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  section: { paddingHorizontal: 20, paddingTop: 24, paddingBottom: 4, borderTopWidth: StyleSheet.hairlineWidth },
  title: { fontSize: 18, fontFamily: fonts.sansBold, marginBottom: 2 },
  lead: { fontSize: 13, fontFamily: fonts.sans, marginBottom: 16, lineHeight: 18 },
  item: { paddingLeft: 12, borderLeftWidth: 3, marginBottom: 20 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  date: { fontSize: 11, fontFamily: fonts.sans, opacity: 0.75, marginRight: 'auto' },
  scope: { fontSize: 11, fontFamily: fonts.sansBold, letterSpacing: 0.6 },
  question: { fontSize: 15, fontFamily: fonts.sansBold, marginTop: 2, lineHeight: 20 },
  body: { marginTop: 6 },
})
