import { useCallback, useEffect, useState, useRef } from 'react'
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, Share, Linking } from 'react-native'
import { Image } from 'expo-image'
import { useFocusEffect, useLocalSearchParams, useRouter, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { userBooksApi, getStorageUrl, getApiConfig, storedBookPercent, formatBookPercent, resumeChapterSlug, isOfflineError, plural } from '@textstack/shared'
import type { UserBookDetailResponse } from '@textstack/shared'
import { enrichUserBook } from '../../src/lib/api'
import { useTheme } from '../../src/context/ThemeContext'
import { useToast } from '../../src/context/ToastContext'
import { useLanguage } from '../../src/context/LanguageContext'
import { fonts } from '../../src/theme/typography'
import { useReconnectCount } from '../../src/hooks/useOnline'
import { LoadingScreen } from '../../src/components/ui/LoadingScreen'
import { EmptyState } from '../../src/components/ui/EmptyState'
import { trackBookOpened } from '../../src/lib/analytics'
import { AddToCollectionSheet } from '../../src/components/library/AddToCollectionSheet'
import { BookInsightsSection } from '../../src/components/library/BookInsightsSection'
import { DiscussWithAssistant } from '../../src/components/library/DiscussWithAssistant'
import { useSheetMount } from '../../src/hooks/useSheetMount'

export default function UserBookDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const router = useRouter()
  const { colors } = useTheme()
  const { show: showToast } = useToast()
  const { t } = useLanguage()
  const [book, setBook] = useState<UserBookDetailResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<'offline' | 'failed' | null>(null)
  const [attempt, setAttempt] = useState(0)
  const reconnects = useReconnectCount()
  const [savedProgress, setSavedProgress] = useState<{ chapterSlug: string | null; percent: number | null; locator: string | null } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [enriching, setEnriching] = useState(false)
  const [collectionSheetOpen, setCollectionSheetOpen] = useState(false)
  // Same reason as everywhere else this sheet appears — see useSheetMount.
  const collectionSheetMounted = useSheetMount(collectionSheetOpen)
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const unmountedRef = useRef(false)

  useEffect(() => {
    unmountedRef.current = false
    return () => { unmountedRef.current = true }
  }, [])

  useEffect(() => {
    if (!id) return
    ;(async () => {
      try {
        const [b, p] = await Promise.all([
          userBooksApi.getUserBook(id),
          userBooksApi.getUserBookProgress(id).catch(err => {
            // Progress failures are non-fatal (guest with no progress yet, offline),
            // but log so they don't hide real bugs (P3-2).
            console.warn('getUserBookProgress failed:', err)
            return null
          }),
        ])
        if (unmountedRef.current) return
        setBook(b)
        if (p) setSavedProgress({ chapterSlug: p.chapterSlug, percent: p.percent, locator: p.locator ?? null })
        setLoadError(null)
      } catch (e) {
        console.error('Failed to load user book:', e)
        if (!unmountedRef.current) setLoadError(isOfflineError(e) ? 'offline' : 'failed')
      } finally {
        if (!unmountedRef.current) setLoading(false)
      }
    })()
    // `reconnects` so the screen recovers on its own — until now a failed load
    // left it showing a spinner until the reader backed out and came in again.
  }, [id, reconnects, attempt])

  // Re-read the progress when this screen comes back into view.
  //
  // The reader is pushed and left with `router.back()`, so this screen is never
  // unmounted and the load effect above — keyed on `[id, reconnects, attempt]`,
  // none of which change — never runs again. QA read a PDF to page 24, backed
  // out, and met a dash, a greyed progress bar and "Start Reading", while the
  // server already held `page:24`. All three are one stale `savedProgress`.
  //
  // Only the progress is re-fetched, not the book: the book's own fields do not
  // change by reading it, and the repo already draws this exact line —
  // `useContinueReadingList` recomputes on focus with the note that "the only
  // thing that changes these values is the user leaving the reader, which is a
  // focus event". Same cancellation shape as there.
  useFocusEffect(
    useCallback(() => {
      if (!id) return
      let cancelled = false
      userBooksApi.getUserBookProgress(id)
        .then(p => {
          if (cancelled || !p) return
          setSavedProgress({ chapterSlug: p.chapterSlug, percent: p.percent, locator: p.locator ?? null })
        })
        // Offline or no progress yet: keep whatever the screen already shows
        // rather than blanking a good value with a failed refresh.
        .catch(() => {})
      return () => { cancelled = true }
    }, [id]),
  )

  // Auto-refresh while processing. Uses recursive setTimeout (not setInterval)
  // so we can implement exponential backoff on repeated failures and avoid
  // hammering the API during an outage (P1-2). Stops immediately once status
  // leaves 'processing'. Guards against `id` going undefined mid-flight (P0-1).
  useEffect(() => {
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current)
      pollTimeoutRef.current = null
    }
    if (!id) return
    if (!book || book.status.toLowerCase() !== 'processing') return

    let cancelled = false
    let consecutiveFailures = 0
    let delayMs = 5000
    const MAX_DELAY_MS = 60_000
    const FAILURE_TOAST_THRESHOLD = 3

    const scheduleNext = () => {
      if (cancelled || unmountedRef.current) return
      pollTimeoutRef.current = setTimeout(tick, delayMs)
    }

    const tick = async () => {
      if (cancelled || unmountedRef.current) return
      // Re-check id every iteration — route params can change under us
      // (user backs out + taps another book) before a prior in-flight call resolves.
      if (!id) return
      try {
        const b = await userBooksApi.getUserBook(id)
        if (cancelled || unmountedRef.current) return
        consecutiveFailures = 0
        delayMs = 5000
        setBook(b)
        // If processing finished, the status-change effect dep will re-run
        // and tear this poll loop down; no need to schedule another tick.
        if (b.status.toLowerCase() === 'processing') scheduleNext()
      } catch (err) {
        if (cancelled || unmountedRef.current) return
        consecutiveFailures += 1
        console.warn(`Poll ${consecutiveFailures} failed for user book ${id}:`, err)
        if (consecutiveFailures === FAILURE_TOAST_THRESHOLD) {
          showToast({
            message: 'Still trying to check processing status…',
            variant: 'info',
            duration: 2600,
          })
        }
        // Exponential backoff: 5s → 10 → 20 → 40 → 60 (capped).
        delayMs = Math.min(delayMs * 2, MAX_DELAY_MS)
        scheduleNext()
      }
    }

    scheduleNext()
    return () => {
      cancelled = true
      if (pollTimeoutRef.current) {
        clearTimeout(pollTimeoutRef.current)
        pollTimeoutRef.current = null
      }
    }
  }, [book?.status, id, showToast])

  // Auto-refresh while metadata enrichment is in flight. The status poll above
  // stops at 'ready' (before enrichment runs), so this covers the Pending/Running
  // window — the worker can't reach the device, so we poll until a terminal
  // state (Completed/Failed) and then stop. Mirrors the web detail page.
  useEffect(() => {
    const s = book?.metadataEnrichmentStatus
    if (!id || (s !== 'Pending' && s !== 'Running')) return
    const interval = setInterval(() => {
      userBooksApi.getUserBook(id)
        .then(b => { if (!unmountedRef.current) setBook(b) })
        .catch(err => console.warn('enrichment poll failed:', err))
    }, 5000)
    return () => clearInterval(interval)
  }, [book?.metadataEnrichmentStatus, id])

  const isReady = book?.status.toLowerCase() === 'ready'
  const isFailed = book?.status.toLowerCase() === 'failed'
  const isProcessing = book && !isReady && !isFailed

  // A PDF read in Original layout is chapterless: its position is a `page:<N>`
  // locator with chapterSlug null. Looking only at the slug meant every
  // half-read PDF reported "never opened". This rule now lives in
  // `resumeChapterSlug` because the catalog screen needed it too and did not
  // have it — the same defect, one screen over.
  const continueSlug = resumeChapterSlug(savedProgress?.chapterSlug, savedProgress?.locator, book?.chapters)

  const handleDelete = () => {
    if (!id) return
    Alert.alert('Delete Book', 'Are you sure you want to delete this book?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          if (deleting) return
          setDeleting(true)
          try {
            await userBooksApi.deleteUserBook(id)
            // Don't reset `deleting` on success — the screen unmounts on router.back()
            // and any lingering state change would warn. (P2-2)
            router.back()
          } catch (err) {
            console.warn('deleteUserBook failed:', err)
            // Surface the failure so the user knows retry is OK.
            showToast({
              message: "Couldn't delete this book. Try again.",
              variant: 'error',
              duration: 2600,
            })
            setDeleting(false)
          }
        },
      },
    ])
  }

  const handleMarkComplete = async () => {
    if (!book || !id) return
    const prevCompletedAt = book.completedAt
    // Optimistic UI — flip first, roll back on failure so the switch doesn't
    // look frozen and errors don't silently swallow the user's intent.
    const optimistic = prevCompletedAt
      ? { ...book, completedAt: null }
      : { ...book, completedAt: new Date().toISOString() }
    setBook(optimistic)
    try {
      if (prevCompletedAt) {
        await userBooksApi.unmarkUserBookComplete(id)
      } else {
        await userBooksApi.markUserBookComplete(id)
      }
    } catch (err) {
      console.warn('markUserBookComplete failed:', err)
      setBook({ ...book, completedAt: prevCompletedAt })
      showToast({
        message: "Couldn't update read status.",
        variant: 'error',
        duration: 2400,
      })
    }
  }

  const handleDownloadEpub = async () => {
    if (!id) return
    try {
      const { baseUrl } = getApiConfig()
      const url = `${baseUrl}/me/books/${id}/export/epub`
      // iOS/Android will hand the URL off to the system browser or a PDF/EPUB
      // reader. Linking.openURL can reject if no handler exists — surface a
      // toast rather than failing silently (B-76).
      const supported = await Linking.canOpenURL(url)
      if (!supported) {
        showToast({ message: "Can't open EPUB download on this device", variant: 'error' })
        return
      }
      await Linking.openURL(url)
    } catch (e) {
      console.warn('Download EPUB failed:', e)
      showToast({ message: 'Could not start EPUB download', variant: 'error' })
    }
  }

  const handleShare = async () => {
    try {
      await Share.share({
        message: `${book?.title || 'Book'}${book?.author ? ` — ${book.author}` : ''}`,
      })
    } catch (e) {
      // Share.share rejects with `ActivityDoesNotExist` on some Android
      // variants and a generic dismissal on iOS. Dismissal is expected, but
      // we still want the log to catch real failures — no toast here because
      // user-dismiss isn't an error they want to see reported.
      console.warn('Share failed:', e)
    }
  }

  // A failed load used to land here and STAY here: `book` stays null, `loading`
  // goes false, and this branch returns a spinner forever — no header, no
  // message, no retry. It is also the only return in this file without a
  // <Stack.Screen>, so the native header never mounts and the content runs under
  // the status bar. That was reported as a layout defect (N-4); it was the error
  // state showing through.
  if (!loading && !book) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: '' }} />
        <View style={[styles.container, { backgroundColor: colors.background }]}>
          <EmptyState
            icon={loadError === 'offline' ? 'cloud-offline-outline' : 'alert-circle-outline'}
            title={loadError === 'offline' ? t('library.offline.title') : t('library.loadFailed.title')}
            subtitle={loadError === 'offline' ? t('library.offline.body') : t('library.loadFailed.body')}
            buttonLabel={t('common.retry')}
            onButtonPress={() => { setLoading(true); setAttempt(a => a + 1) }}
          />
        </View>
      </>
    )
  }

  if (loading || !book) {
    return (
      <>
        <Stack.Screen options={{ headerShown: true, title: '' }} />
        <LoadingScreen />
      </>
    )
  }

  const estPages = book.totalWordCount ? Math.round(book.totalWordCount / 250) : null
  // Read the stored number; do not derive it again.
  //
  // This used to call computeBookProgress with `savedProgress.percent` — already
  // a BOOK fraction — in the `chapterProgress` slot, which takes a CHAPTER
  // fraction. It re-scaled an already-scaled number, so it was wrong for every
  // EPUB too, just plausibly wrong. And it derived only when a chapter slug
  // existed, which a PDF read in Original layout deliberately has none of: the
  // list said 14%, this screen said 0%, and the two agreed only after the
  // locator had been corrupted into chapter space.
  const bookPct = storedBookPercent(savedProgress)
  const progressPct = bookPct != null ? Math.round(bookPct * 100) : 0

  return (
    <>
      <Stack.Screen options={{
        title: book.title || 'My Book',
        headerShown: true,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerShadowVisible: false,
      }} />
      <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
        {/* Header */}
        <View style={styles.header}>
          <Image
            source={book.coverPath ? getStorageUrl(book.coverPath) : undefined}
            style={[styles.cover, { backgroundColor: colors.border }]}
            contentFit="cover"
          />
          <View style={styles.meta}>
            <Text style={[styles.title, { color: colors.text }]}>{book.title || 'Untitled'}</Text>
            {book.author && <Text style={[styles.author, { color: colors.textSecondary }]}>{book.author}</Text>}

            {/* Metadata chips */}
            <View style={styles.chipRow}>
              {isReady && <Chip icon="book-outline" text={`${book.chapters.length} ch`} colors={colors} />}
              {estPages && <Chip icon="document-text-outline" text={`~${plural(estPages, 'page', 'pages')}`} colors={colors} />}
              {book.genre && <Chip icon="pricetag-outline" text={book.genre} colors={colors} />}
              {book.publishedYear && <Chip icon="calendar-outline" text={String(book.publishedYear)} colors={colors} />}
              {book.language && <Chip icon="globe-outline" text={book.language.toUpperCase()} colors={colors} />}
            </View>

            <StatusText status={book.status} colors={colors} />

            {book.completedAt && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 }}>
                <Ionicons name="checkmark-circle" size={14} color={colors.success} />
                <Text style={{ fontSize: 12, color: colors.success, fontFamily: fonts.sansMedium }}>Read</Text>
              </View>
            )}
          </View>
        </View>

        {/* Description */}
        {book.description && (
          <View style={styles.descSection}>
            <Text style={[styles.descText, { color: colors.textSecondary }]}>{book.description}</Text>
          </View>
        )}

        {/* Metadata-enrichment status. Only surfaced while work is in flight
            (Pending/Running) or after a failure — Completed/NotStarted/undefined
            render nothing so we don't nag on old rows. Mirrors the web badge. */}
        {(book.metadataEnrichmentStatus === 'Pending' || book.metadataEnrichmentStatus === 'Running') && (
          <View style={styles.enrichRow}>
            <ActivityIndicator size="small" color={colors.textSecondary} />
            <Text style={[styles.enrichText, { color: colors.textSecondary }]}>Generating book details…</Text>
          </View>
        )}

        {book.metadataEnrichmentStatus === 'Failed' && (
          <View style={styles.enrichRow}>
            <Text style={[styles.enrichText, { color: colors.textSecondary }]}>Couldn't generate details</Text>
            <TouchableOpacity
              disabled={enriching}
              onPress={async () => {
                if (!id || enriching) return
                setEnriching(true)
                const prevStatus = book.metadataEnrichmentStatus
                // Optimistic: flip to Pending so the spinner shows immediately
                // and the enrichment poll effect starts refetching.
                setBook(prev => (prev ? { ...prev, metadataEnrichmentStatus: 'Pending' } : prev))
                try {
                  await enrichUserBook(id)
                } catch (err) {
                  console.warn('enrichUserBook failed:', err)
                  // Roll back to Failed so the user can retry again.
                  setBook(prev => (prev ? { ...prev, metadataEnrichmentStatus: prevStatus } : prev))
                  showToast({ message: "Couldn't generate details", variant: 'error', duration: 2400 })
                } finally {
                  setEnriching(false)
                }
              }}
              accessibilityRole="button"
              accessibilityLabel="Retry generating book details"
            >
              <Text style={[styles.enrichRetry, { color: colors.primary }]}>Retry</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Progress bar */}
        {isReady && (
          <View style={styles.progressSection}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
              <Text style={{ fontSize: 13, color: colors.textSecondary, fontFamily: fonts.sans }}>Reading progress</Text>
              <Text style={{ fontSize: 13, color: colors.primary, fontFamily: fonts.sansMedium }}>
                {formatBookPercent(bookPct)}
              </Text>
            </View>
            <View style={[styles.progressTrack, { backgroundColor: colors.border }]}>
              {/* Empty and muted when unknown — a full-width track next to "—"
                  reads as 0%, which is the claim we just stopped making. */}
              <View style={[
                styles.progressFill,
                { width: `${progressPct}%`, backgroundColor: bookPct == null ? colors.border : colors.primary },
              ]} />
            </View>
          </View>
        )}

        {/* Error message */}
        {isFailed && book.errorMessage && (
          // Tinted from the semantic token rather than a fixed light-mode swatch —
          // the old #FEF2F2 / #991B1B pair was near-invisible in dark mode.
          <View style={[styles.errorBox, { backgroundColor: colors.error + '18', borderColor: colors.error + '40' }]}>
            <Ionicons name="alert-circle" size={18} color={colors.error} />
            <Text style={{ flex: 1, fontSize: 13, color: colors.error, fontFamily: fonts.sans }}>{book.errorMessage}</Text>
          </View>
        )}

        {/* Processing message */}
        {isProcessing && (
          <View style={[styles.processingBox, { backgroundColor: colors.primaryLight }]}>
            <ActivityIndicator size="small" color={colors.primary} />
            <Text style={{ fontSize: 13, color: colors.primary, fontFamily: fonts.sans }}>
              Processing... This may take a few minutes.
            </Text>
          </View>
        )}

        {/* Action buttons */}
        {isReady && book.chapters.length > 0 && (
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.readBtn, { backgroundColor: colors.primary }]}
              onPress={() => {
                const slug = continueSlug || book.chapters[0]?.slug || `chapter-${book.chapters[0]?.chapterNumber}`
                trackBookOpened({ source: 'userbook', userBookId: id })
                router.push(`/my-books/read/${id}/${slug}`)
              }}
            >
              <Ionicons name={continueSlug ? 'play' : 'book'} size={18} color="#fff" />
              <Text style={styles.readBtnText}>{continueSlug ? 'Continue Reading' : 'Start Reading'}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Retry */}
        {isFailed && (
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.retryBtn, { backgroundColor: colors.warning + '22' }]}
              onPress={async () => {
                await userBooksApi.retryUserBook(id!).catch(() => {})
                setBook({ ...book, status: 'Processing' })
              }}
            >
              <Ionicons name="refresh" size={16} color={colors.warning} />
              <Text style={[styles.retryBtnText, { color: colors.warning }]}>Retry Processing</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Secondary actions */}
        {isReady && (
          <View style={styles.secondaryActions}>
            <TouchableOpacity
              style={[styles.secondaryBtn, { borderColor: colors.border }]}
              onPress={handleMarkComplete}
              accessibilityRole="button"
              accessibilityLabel={book.completedAt ? 'Mark book as unread' : 'Mark book as read'}
              accessibilityState={{ selected: !!book.completedAt }}
            >
              <Ionicons name={book.completedAt ? 'close-circle-outline' : 'checkmark-circle-outline'} size={18} color={colors.text} />
              <Text style={[styles.secondaryBtnText, { color: colors.text }]}>
                {book.completedAt ? 'Mark as unread' : 'Mark as read'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.secondaryBtn, { borderColor: colors.border }]}
              onPress={handleDownloadEpub}
              accessibilityRole="button"
              accessibilityLabel="Download EPUB"
            >
              <Ionicons name="download-outline" size={18} color={colors.text} />
              <Text style={[styles.secondaryBtnText, { color: colors.text }]}>Download EPUB</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.secondaryBtn, { borderColor: colors.border }]}
              onPress={() => setCollectionSheetOpen(true)}
              accessibilityRole="button"
              accessibilityLabel={t('library.actions.addToCollection')}
            >
              <Ionicons name="folder-outline" size={18} color={colors.text} />
              <Text style={[styles.secondaryBtnText, { color: colors.text }]}>{t('library.actions.addToCollection')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.secondaryBtn, { borderColor: colors.border }]}
              onPress={handleShare}
              accessibilityRole="button"
              accessibilityLabel={`Share ${book.title || 'book'}`}
            >
              <Ionicons name="share-outline" size={18} color={colors.text} />
              <Text style={[styles.secondaryBtnText, { color: colors.text }]}>Share</Text>
            </TouchableOpacity>
          </View>
        )}

        {collectionSheetMounted && <AddToCollectionSheet
          visible={collectionSheetOpen}
          bookId={isReady ? book.id : null}
          bookType="userbook"
          onClose={() => setCollectionSheetOpen(false)}
          onAdded={(name) => showToast({ message: t('library.actions.addedToCollection').replace('{{name}}', name), variant: 'success' })}
        />}

        {/* Above the chapter list on purpose: coming back to a book, what you
            already worked out is more use than the table of contents. */}
        {isReady && <BookInsightsSection userBookId={book.id} />}

        {/* Directly under it: the section shows what came back, this is how you
            go and get more. */}
        {isReady && (
          <DiscussWithAssistant
            title={book.title}
            author={book.author}
            bookId={book.id}
            progressFraction={bookPct}
            chapterTitle={book.chapters.find(c => c.slug === continueSlug)?.title ?? null}
          />
        )}

        {/* Chapter list */}
        {isReady && book.chapters.length > 0 && (
          <View style={[styles.chaptersSection, { borderTopColor: colors.border }]}>
            <Text style={[styles.chaptersTitle, { color: colors.text }]}>Chapters</Text>
            {book.chapters.map((ch, i) => {
              const isCurrentChapter = continueSlug === ch.slug
              return (
                <TouchableOpacity
                  key={ch.id}
                  style={[styles.chapterRow, { borderBottomColor: colors.border }]}
                  onPress={() => router.push(`/my-books/read/${id}/${ch.slug || `chapter-${ch.chapterNumber}`}`)}
                >
                  <Text style={[styles.chapterNumber, { color: isCurrentChapter ? colors.primary : colors.textSecondary }]}>{i + 1}</Text>
                  <View style={{ flex: 1 }}>
                    <Text
                      style={[styles.chapterTitle, { color: isCurrentChapter ? colors.primary : colors.text }, isCurrentChapter && { fontFamily: fonts.sansMedium }]}
                      numberOfLines={1}
                    >
                      {ch.title}
                    </Text>
                    {ch.wordCount && (
                      <Text style={{ fontSize: 11, color: colors.textSecondary, fontFamily: fonts.sans, marginTop: 2 }}>
                        {ch.wordCount.toLocaleString()} {plural(ch.wordCount, 'word', 'words', '{noun}')}
                      </Text>
                    )}
                  </View>
                  {isCurrentChapter && <Ionicons name="play-circle" size={18} color={colors.primary} />}
                </TouchableOpacity>
              )
            })}
          </View>
        )}

        {/* Delete */}
        <View style={styles.dangerSection}>
          <TouchableOpacity
            style={[styles.deleteBtn, { borderColor: colors.error + '40' }]}
            onPress={handleDelete}
            disabled={deleting}
          >
            <Ionicons name="trash-outline" size={16} color={colors.error} />
            <Text style={{ fontSize: 14, color: colors.error, fontFamily: fonts.sansMedium }}>
              {deleting ? 'Deleting...' : 'Delete Book'}
            </Text>
          </TouchableOpacity>
        </View>

        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  )
}

function Chip({ icon, text, colors }: { icon: string; text: string; colors: any }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: colors.border }}>
      <Ionicons name={icon as any} size={12} color={colors.textSecondary} />
      <Text style={{ fontSize: 11, color: colors.textSecondary, fontFamily: fonts.sans }}>{text}</Text>
    </View>
  )
}

function StatusText({ status, colors }: { status: string; colors: any }) {
  const s = status.toLowerCase()
  if (s === 'ready') return null
  if (s === 'failed') return <Text style={[styles.statusFail, { color: colors.error }]}>Failed</Text>
  return <Text style={[styles.statusPending, { color: colors.primary }]}>Processing...</Text>
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  container: { flex: 1 },
  header: { flexDirection: 'row', padding: 16 },
  cover: { width: 110, height: 165, borderRadius: 8 },
  meta: { flex: 1, marginLeft: 16, justifyContent: 'center' },
  title: { fontSize: 18, fontFamily: fonts.serifBold },
  author: { fontSize: 14, fontFamily: fonts.sans, marginTop: 4 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10 },
  descSection: { paddingHorizontal: 16, marginBottom: 12 },
  descText: { fontSize: 13, fontFamily: fonts.sans, lineHeight: 20 },
  enrichRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, marginBottom: 12 },
  enrichText: { fontSize: 13, fontFamily: fonts.sans },
  enrichRetry: { fontSize: 13, fontFamily: fonts.sansMedium },
  progressSection: { paddingHorizontal: 16, marginBottom: 12 },
  progressTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 3 },
  errorBox: { marginHorizontal: 16, marginBottom: 12, padding: 12, borderRadius: 8, borderWidth: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  processingBox: { marginHorizontal: 16, marginBottom: 12, padding: 12, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 8 },
  actions: { paddingHorizontal: 16, marginTop: 4, gap: 8 },
  readBtn: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  readBtnText: { color: '#fff', fontSize: 16, fontFamily: fonts.sansMedium },
  retryBtn: {
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  retryBtnText: { fontSize: 14, fontFamily: fonts.sansMedium },
  secondaryActions: { paddingHorizontal: 16, marginTop: 12, gap: 8 },
  secondaryBtn: {
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  secondaryBtnText: { fontSize: 14, fontFamily: fonts.sansMedium },
  statusFail: { fontSize: 12, marginTop: 6, fontFamily: fonts.sansMedium },
  statusPending: { fontSize: 12, marginTop: 6, fontFamily: fonts.sansMedium },
  chaptersSection: { paddingHorizontal: 16, marginTop: 20, borderTopWidth: 1, paddingTop: 16 },
  chaptersTitle: { fontSize: 16, fontFamily: fonts.serifBold, marginBottom: 12 },
  chapterRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 12, borderBottomWidth: 1, gap: 4 },
  chapterNumber: { width: 28, fontSize: 13, fontFamily: fonts.sansMedium },
  chapterTitle: { fontSize: 14, fontFamily: fonts.sans },
  dangerSection: { paddingHorizontal: 16, marginTop: 24 },
  deleteBtn: {
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
})
