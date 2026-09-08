import { useEffect, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { insightsApi, type BookInsight } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { fonts } from '../../theme/typography'
import { AskMarkdown } from '../AskMarkdown'

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
 * Markdown goes through `AskMarkdown`, the renderer the Ask sheet already uses:
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
  const [insights, setInsights] = useState<BookInsight[]>([])
  const [loading, setLoading] = useState(true)

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

  if (loading || insights.length === 0) return null

  return (
    <View style={[styles.section, { borderTopColor: colors.border }]}>
      <Text style={[styles.title, { color: colors.text }]}>What you&apos;ve worked out</Text>
      <Text style={[styles.lead, { color: colors.textSecondary }]}>
        Conclusions your assistant wrote back into this book.
      </Text>

      {insights.map(insight => (
        <View key={insight.id} style={[styles.item, { borderLeftColor: colors.border }]}>
          {/* The TITLE, never the number. `chapterNumber` is what the server orders
              by, but the two book types number differently — a catalog screen adds
              one, an upload does not — so printing it reads one off the table of
              contents on exactly one of them. */}
          <Text style={[styles.scope, { color: colors.textSecondary }]}>
            {insight.chapterSlug === null
              ? 'THIS BOOK'
              // A slug that no longer resolves (a re-ingest renamed the chapter)
              // keeps its text and shows unplaced rather than disappearing.
              : (insight.chapterTitle ?? insight.chapterSlug).toUpperCase()}
          </Text>

          {insight.question ? (
            <Text style={[styles.question, { color: colors.text }]}>{insight.question}</Text>
          ) : null}

          <View style={styles.body}>
            <AskMarkdown text={insight.text} />
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
  scope: { fontSize: 11, fontFamily: fonts.sansBold, letterSpacing: 0.6 },
  question: { fontSize: 15, fontFamily: fonts.sansBold, marginTop: 2, lineHeight: 20 },
  body: { marginTop: 6 },
})
