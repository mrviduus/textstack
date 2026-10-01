import { useEffect, useState } from 'react'
import { ScrollView, View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native'
import { Stack, router, useLocalSearchParams } from 'expo-router'
import {
  createBooksApi, highlightsApi, insightDateLabel, nextChapterAfter, resolveReviewHighlights, userBooksApi,
  type ChapterReviewBlock, type PublicHighlight,
} from '@textstack/shared'
import { useTheme } from '../src/context/ThemeContext'
import { useLanguage } from '../src/context/LanguageContext'
import { useAuth } from '../src/context/AuthContext'
import { useBookReviews } from '../src/hooks/useBookReviews'
import { ReviewChapterButton } from '../src/components/library/ReviewChapterButton'
import { chapterReviewRoute, type ReviewBookRef } from '../src/lib/chapterReviewLaunch'
import { EmptyState } from '../src/components/ui/EmptyState'
import { fonts } from '../src/theme/typography'

/**
 * One chapter's review as it came back from the reader's assistant (chapter-review.md §12).
 * Params: `userBookId` (upload) or `editionId` + `slug` (catalog), plus `chapterSlug`.
 * Titles only — `chapter_number` is an ordering key, never displayed.
 */
interface ReviewBook {
  title: string
  author: string | null
  ref: ReviewBookRef
  chapters: { slug: string | null; title: string }[]
}

export default function ChapterReviewScreen() {
  const { userBookId, editionId, slug, chapterSlug = '' } =
    useLocalSearchParams<{ userBookId?: string; editionId?: string; slug?: string; chapterSlug: string }>()
  const { colors } = useTheme()
  const { t, language } = useLanguage()
  const { isAuthenticated } = useAuth()
  const [book, setBook] = useState<ReviewBook | null>(null)
  const [bookError, setBookError] = useState(false)
  const [highlights, setHighlights] = useState<PublicHighlight[] | null>(null)

  useEffect(() => {
    if (!isAuthenticated) return
    let cancelled = false
    setBookError(false)
    const load: Promise<ReviewBook> = userBookId
      ? userBooksApi.getUserBook(userBookId).then(b => ({
          title: b.title, author: b.author ?? null, ref: { userBookId: b.id },
          chapters: b.chapters.map(c => ({ slug: c.slug ?? null, title: c.title })),
        }))
      : createBooksApi(language).getBook(slug!).then(b => ({
          title: b.title, author: b.authors.map(a => a.name).join(', ') || null,
          ref: { editionId: editionId ?? b.id, slug: b.slug },
          chapters: b.chapters.map(c => ({ slug: c.slug, title: c.title })),
        }))
    load.then(b => { if (!cancelled) setBook(b) }).catch(() => { if (!cancelled) setBookError(true) })
    return () => { cancelled = true }
  }, [userBookId, editionId, slug, language, isAuthenticated])

  const target = book ? ('userBookId' in book.ref ? { userBookId: book.ref.userBookId } : { editionId: book.ref.editionId }) : null
  const { insights, reviews, loading, error } = useBookReviews(target)

  useEffect(() => {
    if (!book) return
    let cancelled = false
    const load = 'userBookId' in book.ref
      ? highlightsApi.getUserBookHighlights(book.ref.userBookId)
      : highlightsApi.getHighlights(book.ref.editionId)
    // Null on failure, not []: an empty list would label every quote "highlight removed".
    load.then(h => { if (!cancelled) setHighlights(h) }).catch(() => {})
    return () => { cancelled = true }
  }, [book])

  const screen = (
    <Stack.Screen options={{
      title: book?.title ?? t('chapterReview.summary.title'),
      headerShown: true,
      headerStyle: { backgroundColor: colors.background },
      headerTintColor: colors.text,
      headerTitleStyle: { fontFamily: fonts.sansMedium, fontSize: 16 },
      headerShadowVisible: false,
    }} />
  )
  const wrap = (children: React.ReactNode) => (
    <>{screen}<View style={{ flex: 1, backgroundColor: colors.background }}>{children}</View></>
  )

  if (!isAuthenticated) {
    return wrap(
      <EmptyState icon="book-outline" title={t('chapterReview.summary.signIn')}
        buttonLabel={t('connect.signIn.cta')} onButtonPress={() => router.push('/(auth)/login')} />,
    )
  }
  if (bookError || error) return wrap(<EmptyState icon="cloud-offline-outline" title={t('chapterReview.summary.loadFailed')} />)
  if (!book || loading) return wrap(<ActivityIndicator style={{ marginTop: 48 }} color={colors.primary} />)

  const insight = reviews.get(chapterSlug)
  const chapter = book.chapters.find(c => c.slug === chapterSlug)
  if (!chapter && !insight) return wrap(<EmptyState icon="help-circle-outline" title={t('chapterReview.summary.notFound')} />)

  const chapterTitle = chapter?.title ?? insight?.chapterTitle ?? chapterSlug
  const briefBook = {
    title: book.title, author: book.author,
    ...('userBookId' in book.ref ? { bookId: book.ref.userBookId } : { editionId: book.ref.editionId, slug: book.ref.slug }),
  }
  const next = nextChapterAfter(book.chapters, chapterSlug)
  const review = insight?.review
  const date = insight ? insightDateLabel(insight) : null
  const threadText = new Map(insights.flatMap(i => i.review?.openThreads ?? []).map(th => [th.id, th.text]))
  const closed = (review?.closedThreadIds ?? []).map(id => threadText.get(id)).filter((x): x is string => !!x)
  const nextLabel = next ? t('chapterReview.summary.next').replace('{{title}}', next.title) : ''

  return wrap(
    <ScrollView contentContainerStyle={styles.content}>
      <Text style={[styles.title, { color: colors.text }]}>{chapterTitle}</Text>
      {date && (
        <Text style={[styles.muted, { color: colors.textSecondary }]}>
          {t('chapterReview.summary.reviewedOn').replace('{{date}}', date)}
        </Text>
      )}

      {!review ? (
        <View style={styles.empty}>
          <Text style={[styles.h2, { color: colors.text, textAlign: 'center' }]}>{t('chapterReview.summary.emptyTitle')}</Text>
          <Text style={[styles.body, { color: colors.textSecondary, textAlign: 'center' }]}>{t('chapterReview.summary.emptyLead')}</Text>
          <ReviewChapterButton {...briefBook} chapterSlug={chapterSlug} chapterTitle={chapterTitle} primary />
        </View>
      ) : (
        <>
          {review.recall && (
            <View style={[styles.card, { borderColor: colors.border }]}>
              <Text style={[styles.label, { color: colors.textSecondary }]}>{t('chapterReview.summary.recall')}</Text>
              <Text style={[styles.body, { color: colors.text }]}>{review.recall}</Text>
            </View>
          )}
          {review.blocks.map((b, i) => <BlockCard key={i} index={i} block={b} highlights={highlights} />)}
          <Bullets title={t('chapterReview.summary.applications')} items={review.applications} />
          <Bullets
            title={t('chapterReview.summary.openThreads').replace('{{count}}', String(review.openThreads.length))}
            items={review.openThreads.map(th => th.text)}
          />
          <Bullets title={t('chapterReview.summary.closedThreads')} items={closed} />
          <View style={styles.actions}>
            <ReviewChapterButton {...briefBook} chapterSlug={chapterSlug} chapterTitle={chapterTitle}
              label={t('chapterReview.summary.again')} primary />
          </View>
        </>
      )}

      {next?.slug && (
        <View style={styles.actions}>
          {reviews.has(next.slug) ? (
            <TouchableOpacity onPress={() => router.replace(chapterReviewRoute(book.ref, next.slug!))} accessibilityRole="link">
              <Text style={[styles.link, { color: colors.primary }]}>{nextLabel}</Text>
            </TouchableOpacity>
          ) : (
            <ReviewChapterButton {...briefBook} chapterSlug={next.slug} chapterTitle={next.title} label={nextLabel} primary />
          )}
        </View>
      )}
    </ScrollView>,
  )
}

function Bullets({ title, items }: { title: string; items: string[] }) {
  const { colors } = useTheme()
  if (items.length === 0) return null
  return (
    <View style={styles.section}>
      <Text style={[styles.h2, { color: colors.text }]}>{title}</Text>
      {items.map((it, i) => <Text key={i} style={[styles.body, { color: colors.text }]}>• {it}</Text>)}
    </View>
  )
}

function BlockCard({ index, block, highlights }: { index: number; block: ChapterReviewBlock; highlights: PublicHighlight[] | null }) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const [shown, setShown] = useState(false)
  const quotes = highlights ? resolveReviewHighlights(block.highlightIds, highlights) : null

  return (
    <View style={[styles.card, { borderColor: colors.border }]}>
      <Text style={[styles.h2, { color: colors.text }]}>{index + 1}. {block.title}</Text>
      <Text style={[styles.label, { color: colors.textSecondary }]}>{t('chapterReview.summary.problem')}</Text>
      <Text style={[styles.body, { color: colors.text }]}>{block.problem}</Text>
      <Text style={[styles.label, { color: colors.textSecondary }]}>{t('chapterReview.summary.why')}</Text>
      <Text style={[styles.body, { color: colors.text }]}>{block.rootCause}</Text>
      <View style={[styles.rule, { backgroundColor: colors.primary + '22' }]}>
        <Text style={[styles.ruleText, { color: colors.text }]}>★ {t('chapterReview.summary.rule')}: {block.rule}</Text>
      </View>
      <Text style={[styles.label, { color: colors.textSecondary }]}>{t('chapterReview.summary.highlights')}</Text>
      {block.highlightIds.length === 0 ? (
        <Text style={[styles.body, { color: colors.textSecondary }]}>{t('chapterReview.summary.noHighlights')}</Text>
      ) : quotes?.map(q => (
        <Text key={q.id} style={[styles.body, q.text ? styles.quote : null, { color: q.text ? colors.text : colors.textSecondary }]}>
          {q.text ? `“${q.text}”` : t('chapterReview.summary.highlightRemoved')}
        </Text>
      ))}
      <Text style={[styles.label, { color: colors.textSecondary }]}>{t('chapterReview.summary.check')}</Text>
      <Text style={[styles.body, { color: colors.text }]}>{block.question.prompt}</Text>
      <TouchableOpacity onPress={() => setShown(s => !s)} accessibilityRole="button" style={styles.reveal}>
        <Text style={[styles.link, { color: colors.primary }]}>
          {shown ? t('chapterReview.summary.hide') : t('chapterReview.summary.show')}
        </Text>
      </TouchableOpacity>
      {shown && <Text style={[styles.body, styles.answer, { color: colors.text, borderLeftColor: colors.border }]}>{block.question.answer}</Text>}
    </View>
  )
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 48 },
  title: { fontSize: 24, fontFamily: fonts.serifBold },
  muted: { fontSize: 12, fontFamily: fonts.sans, marginTop: 4, marginBottom: 16 },
  h2: { fontSize: 16, fontFamily: fonts.sansBold, marginBottom: 6 },
  body: { fontSize: 15, lineHeight: 22, fontFamily: fonts.sans },
  label: { fontSize: 11, fontFamily: fonts.sansMedium, letterSpacing: 0.6, textTransform: 'uppercase', marginTop: 12, marginBottom: 2 },
  card: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, padding: 14, marginTop: 14 },
  rule: { marginTop: 12, padding: 10, borderRadius: 8 },
  ruleText: { fontSize: 15, lineHeight: 21, fontFamily: fonts.sansBold },
  quote: { fontStyle: 'italic' },
  reveal: { marginTop: 6, alignSelf: 'flex-start' },
  answer: { marginTop: 6, paddingLeft: 10, borderLeftWidth: 3 },
  section: { marginTop: 20 },
  actions: { marginTop: 24 },
  empty: { alignItems: 'center', gap: 12, paddingVertical: 32 },
  link: { fontSize: 15, fontFamily: fonts.sansMedium },
})
