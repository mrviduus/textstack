import { useEffect, useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { insightsApi, insightChapterLabel, type BookInsight } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { Ionicons } from '@expo/vector-icons'
import { fonts } from '../../theme/typography'
import { Markdown } from '../Markdown'

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
  /** Exactly one of these. */
  userBookId?: string
  editionId?: string
}

export function BookInsightsSection({ userBookId, editionId }: Props) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const [insights, setInsights] = useState<BookInsight[]>([])
  const [loading, setLoading] = useState(true)
  // The id being removed, so the row cannot be double-tapped into two requests.
  const [removing, setRemoving] = useState<string | null>(null)

  useEffect(() => {
    const target = userBookId ? { userBookId } : editionId ? { editionId } : null
    if (!target) return

    let cancelled = false
    setLoading(true)
    insightsApi.getBookInsights(target)
      .then(rows => { if (!cancelled) setInsights(rows) })
      // Silent: a supplementary panel must never take the book screen down with
      // it, and a signed-out reader gets a 401 here as a matter of course.
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [userBookId, editionId])

  // A conclusion filed against the WRONG chapter is never revisited by the assistant — it only ever
  // replaces its own row for the chapter it meant. Removing it is the reader's, and only the
  // reader's: there is no assistant-side delete, by design.
  const remove = async (id: string) => {
    setRemoving(id)
    try {
      await insightsApi.deleteBookInsight(id)
      setInsights(prev => prev.filter(i => i.id !== id))
    } catch {
      // The row stays, which is the honest outcome — it is still on the server.
    } finally {
      setRemoving(null)
    }
  }

  if (loading || insights.length === 0) return null

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
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  scope: { fontSize: 11, fontFamily: fonts.sansBold, letterSpacing: 0.6 },
  question: { fontSize: 15, fontFamily: fonts.sansBold, marginTop: 2, lineHeight: 20 },
  body: { marginTop: 6 },
})
