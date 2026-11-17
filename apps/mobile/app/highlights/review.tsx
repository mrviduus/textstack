import { useEffect, useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native'
import { Stack, useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { isOfflineError, plural } from '@textstack/shared'
import { highlightsApi } from '../../src/lib/highlightsApi'
import type { HighlightReviewItem } from '@textstack/shared'
import { OffV2 } from '../../src/components/OffV2'
import { useReconnectCount } from '../../src/hooks/useOnline'
import { useTheme } from '../../src/context/ThemeContext'
import { fonts } from '../../src/theme/typography'
import { HighlightQuote } from '../../src/components/HighlightQuote'

const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: '#FEF3C7',
  green: '#D1FAE5',
  pink: '#FCE7F3',
  blue: '#DBEAFE',
}

/**
 * Revisiting saved highlights, one at a time.
 *
 * It was called "review" and its summary said "Reviewed N highlights", which promised something the
 * screen never did: there is no question, no recall, no self-assessment — you read the passage and
 * press Next. The server has no recall model to hold one either; `Highlight` carries a single
 * `LastReviewedAt` and the queue is a 24-hour cooldown, with no interval, schedule or review log.
 * Rather than dress a page-turner as spaced repetition, it now says what it is. Real recall for
 * highlights is recorded as deliberately-not-done in docs/STATUS.md.
 */
/** M5 (#1031): no highlight review on V2: back to the highlights. */
export default function HighlightReviewRoute() {
  return <OffV2 feature="highlightReview" href="/highlights"><HighlightReviewScreen /></OffV2>
}

function HighlightReviewScreen() {
  const router = useRouter()
  const { colors } = useTheme()
  const [items, setItems] = useState<HighlightReviewItem[]>([])
  const [index, setIndex] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<'offline' | 'failed' | null>(null)
  const [attempt, setAttempt] = useState(0)
  const reconnects = useReconnectCount()
  const [done, setDone] = useState(false)
  const [seen, setSeen] = useState(0)

  useEffect(() => {
    // The review screen is short-lived — user can back-gesture mid-fetch,
    // at which point setItems / setLoading would warn. Cancellation flag
    // keeps state updates bound to the current mount.
    let cancelled = false
    highlightsApi.getHighlightsForReview(20)
      .then(res => { if (!cancelled) { setItems(res); setLoadError(null) } })
      .catch(e => {
        if (cancelled) return
        console.warn('Failed to load review items:', e)
        // "All caught up!" is a congratulation. Saying it to someone whose
        // highlights failed to load is the same class of lie as telling an
        // offline reader they own no books.
        setLoadError(isOfflineError(e) ? 'offline' : 'failed')
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => {
      cancelled = true
    }
  }, [reconnects, attempt])

  const current = items[index]

  const handleNext = async () => {
    if (current) {
      try {
        await highlightsApi.markHighlightReviewed(current.id)
        // Counted only on success. The increment used to sit outside the try, so a run with no
        // network still finished by claiming a number of highlights the server had never heard of.
        setSeen(n => n + 1)
      } catch (e) {
        // Non-fatal — revisiting is a convenience, not a hard state.
        // Log so QA can spot bursts of failures, but keep the flow moving.
        console.warn('Failed to mark highlight reviewed:', e)
      }
    }
    if (index < items.length - 1) {
      setIndex(i => i + 1)
    } else {
      setDone(true)
    }
  }

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ title: 'Revisit Highlights', headerShown: true }} />
        <ActivityIndicator style={{ flex: 1 }} color={colors.primary} />
      </>
    )
  }

  if (items.length === 0 && loadError) {
    return (
      <>
        <Stack.Screen options={{ title: 'Revisit Highlights', headerShown: true, headerStyle: { backgroundColor: colors.background }, headerShadowVisible: false }} />
        <View style={[styles.center, { backgroundColor: colors.background }]}>
          <Ionicons
            name={loadError === 'offline' ? 'cloud-offline-outline' : 'alert-circle-outline'}
            size={48}
            color={colors.textSecondary}
          />
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            {loadError === 'offline'
              ? "You're offline — your highlights will be here when you reconnect."
              : "Couldn't load your highlights."}
          </Text>
          <TouchableOpacity onPress={() => { setLoading(true); setAttempt(a => a + 1) }}>
            <Text style={[styles.emptyText, { color: colors.primary }]}>Try again</Text>
          </TouchableOpacity>
        </View>
      </>
    )
  }

  if (items.length === 0) {
    return (
      <>
        <Stack.Screen options={{ title: 'Revisit Highlights', headerShown: true, headerStyle: { backgroundColor: colors.background }, headerShadowVisible: false }} />
        <View style={[styles.center, { backgroundColor: colors.background }]}>
          <Ionicons name="checkmark-circle-outline" size={48} color={colors.success} />
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>Nothing new to revisit — each of these comes back a day after you last saw it.</Text>
        </View>
      </>
    )
  }

  // Summary screen after completing all cards
  if (done) {
    return (
      <>
        <Stack.Screen options={{ title: 'Done', headerShown: true, headerStyle: { backgroundColor: colors.background }, headerShadowVisible: false }} />
        <View style={[styles.center, { backgroundColor: colors.background }]}>
          <Ionicons name="checkmark-circle" size={56} color={colors.success} />
          <Text style={[styles.summaryTitle, { color: colors.text }]}>That's the set</Text>
          <Text style={[styles.summaryCount, { color: colors.textSecondary }]}>
            {plural(seen, 'highlight', 'highlights', 'You revisited {n} {noun}')}
          </Text>
          <TouchableOpacity
            style={[styles.summaryBtn, { backgroundColor: colors.primary }]}
            onPress={() => router.back()}
          >
            <Text style={styles.summaryBtnText}>Back to Highlights</Text>
          </TouchableOpacity>
        </View>
      </>
    )
  }

  const bgColor = HIGHLIGHT_COLORS[current.color] || HIGHLIGHT_COLORS.yellow

  return (
    <>
      <Stack.Screen options={{
        title: `${index + 1} / ${items.length}`,
        headerShown: true,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
      }} />
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={[styles.card, { backgroundColor: bgColor }]}>
          <HighlightQuote
            anchorJson={current.anchorJson}
            selectedText={current.selectedText}
            numberOfLines={12}
            style={styles.quoteText}
          />
          {current.noteText && (
            <Text style={[styles.noteText, { color: colors.textSecondary }]}>{current.noteText}</Text>
          )}
          <View style={styles.meta}>
            {current.bookTitle && (
              <Text style={[styles.metaText, { color: colors.textSecondary }]}>{current.bookTitle}</Text>
            )}
            {current.chapterTitle && (
              <Text style={[styles.metaText, { color: colors.textSecondary }]}>{current.chapterTitle}</Text>
            )}
          </View>
        </View>

        <TouchableOpacity
          style={[styles.nextButton, { backgroundColor: colors.primary }]}
          onPress={handleNext}
          activeOpacity={0.85}
        >
          <Text style={styles.nextText}>
            {index < items.length - 1 ? 'Next' : 'Done'}
          </Text>
          <Ionicons name={index < items.length - 1 ? 'arrow-forward' : 'checkmark'} size={18} color="#fff" />
        </TouchableOpacity>
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12, padding: 24 },
  card: { borderRadius: 16, padding: 24, marginBottom: 32 },
  // `flipHint` used to live here, styling the words "Tap Next to continue" — named for a flip this
  // screen has never had. Both are gone.
  quoteText: { fontSize: 20, lineHeight: 30, textAlign: 'center' },
  noteText: { fontFamily: fonts.sans, fontSize: 14, marginTop: 16, textAlign: 'center' },
  meta: { marginTop: 20, alignItems: 'center', gap: 2 },
  metaText: { fontFamily: fonts.sans, fontSize: 12 },
  nextButton: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 8, paddingVertical: 14, borderRadius: 12 },
  nextText: { color: '#fff', fontFamily: fonts.sansMedium, fontSize: 16 },
  emptyText: { fontFamily: fonts.sans, fontSize: 15, textAlign: 'center' },
  summaryTitle: { fontFamily: fonts.serifBold, fontSize: 24, marginTop: 12 },
  summaryCount: { fontFamily: fonts.sans, fontSize: 15 },
  summaryBtn: { marginTop: 24, paddingVertical: 14, paddingHorizontal: 32, borderRadius: 12 },
  summaryBtnText: { color: '#fff', fontFamily: fonts.sansMedium, fontSize: 16 },
})
