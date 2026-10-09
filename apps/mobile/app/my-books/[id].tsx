import { useEffect, useState, useRef } from 'react'
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from 'react-native'
import { Image } from 'expo-image'
import { useLocalSearchParams, useRouter, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import NetInfo from '@react-native-community/netinfo'
import { userBooksApi, currentReviewChapter, getStorageUrl, storedBookPercent, formatBookPercent, resumeChapterSlug, isOfflineError, plural, bookPages } from '@textstack/shared'
import type { UserBookDetailResponse } from '@textstack/shared'
import { enrichUserBook } from '../../src/lib/api'
import { useTheme } from '../../src/context/ThemeContext'
import { useToast } from '../../src/context/ToastContext'
import { useLanguage } from '../../src/context/LanguageContext'
import { useDownload } from '../../src/context/DownloadContext'
import { fonts } from '../../src/theme/typography'
import { useReconnectCount } from '../../src/hooks/useOnline'
import { LoadingScreen } from '../../src/components/ui/LoadingScreen'
import { EmptyState } from '../../src/components/ui/EmptyState'
import { OfflineBanner } from '../../src/components/ui/OfflineBanner'
import { shareOriginalFile } from '../../src/lib/shareOriginal'
import { cachedUserBookDetail } from '../../src/lib/cachedUserBookDetail'
import { getCachedOriginalUri } from '../../src/lib/originalFileCache'
import { shouldConfirmOnCellular } from '../../src/lib/originalFilePolicy'
import { formatBytes } from '../../src/lib/formatBytes'
import { getCachedUserBookMeta, listCachedUserChapters, isUserBookFullyCached } from '../../src/lib/offlineDb'
import { getUserBookLocalProgress } from '../../src/lib/progressStorage'
import { userBookChapterSlug } from '../../src/lib/userBookChapters'
import { AddToCollectionSheet } from '../../src/components/library/AddToCollectionSheet'
import { DownloadButton } from '../../src/components/library/DownloadButton'
import { BookInsightsSection } from '../../src/components/library/BookInsightsSection'
import { AssistantMenu } from '../../src/components/library/AssistantMenu'
import { ChapterReviewAction } from '../../src/components/library/ReviewChapterButton'
import { useBookReviews } from '../../src/hooks/useBookReviews'
import { useRefocusEffect } from '../../src/hooks/useRefocusEffect'
import { useSheetMount } from '../../src/hooks/useSheetMount'

/**
 * Everything this screen needs, read off the device: the book payload rebuilt
 * from the download, and the last position the reader wrote locally.
 *
 * Returns null when there is no usable copy — no meta row, or a meta row with
 * no chapters behind it (a download cancelled on its first chapter). The caller
 * then falls through to the real error state, because in that case there is
 * genuinely nothing to show.
 */
async function rehydrateFromCache(bookId: string): Promise<{
  book: UserBookDetailResponse
  progress: { chapterSlug: string | null; percent: number | null; locator: string | null } | null
  /** The upload was a PDF, so what is about to be rendered is its extracted
   *  text rather than the pages. The screen says so rather than letting the
   *  reader discover it. */
  isPdf: boolean
} | null> {
  try {
    const meta = await getCachedUserBookMeta(bookId)
    if (!meta) return null
    const [chapters, local] = await Promise.all([
      listCachedUserChapters(bookId),
      getUserBookLocalProgress(bookId),
    ])
    if (chapters.length === 0) return null
    // Whether the Original layout is available offline is a question about the
    // filesystem, which the pure rebuilder cannot ask.
    const storedOriginal = meta.isPdf ? await getCachedOriginalUri(bookId, 'pdf') : null
    return {
      book: cachedUserBookDetail(meta, chapters, storedOriginal !== null),
      isPdf: meta.isPdf,
      progress: local
        ? {
            chapterSlug: local.chapterSlug ?? null,
            percent: typeof local.bookPercent === 'number' ? local.bookPercent : null,
            // The same `page:<N>` shape the server would have returned, so
            // `resumeChapterSlug` and `storedBookPercent` read it unchanged.
            locator: typeof local.page === 'number' ? `page:${local.page}` : null,
          }
        : null,
    }
  } catch (err) {
    console.warn('Offline user-book rehydrate failed:', err)
    return null
  }
}


/**
 * One question before a large download on a metered connection.
 *
 * Not a refusal: blocking mobile data outright is what infuriates someone
 * deliberately grabbing a book before a flight. The connection type is read at
 * the moment of the tap rather than tracked — that is the only moment it
 * matters, and `useOnline` deliberately exposes reachability, not the kind of
 * link. Resolves true when the download should proceed.
 */
async function confirmDownloadOnCellular(book: UserBookDetailResponse): Promise<boolean> {
  const bytes = typeof book.originalFileBytes === 'number' ? book.originalFileBytes : null
  // Only an original makes a download big enough to be worth asking about;
  // chapters are text.
  if (book.hasOriginalPdf !== true) return true

  let cellular = false
  try {
    const state = await NetInfo.fetch()
    cellular = state.type === 'cellular'
  } catch {
    // Unknown connection: do not invent a prompt for a link we cannot see.
    return true
  }
  if (!shouldConfirmOnCellular(bytes, cellular)) return true

  const size = formatBytes(bytes)
  return new Promise<boolean>(resolve => {
    Alert.alert(
      'Download over mobile data?',
      size
        ? `This book's original pages are ${size}.`
        : "This book's original pages may be large.",
      [
        { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Download', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    )
  })
}

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
  const { downloads, startUserBookDownload, cancelDownload, removeUserBookDownload, retryFailed } = useDownload()
  // Is the whole book on the device? Answered from SQLite rather than from the
  // download map, which is in-memory and empty after an app restart.
  const [cached, setCached] = useState(false)
  /** Rendering the cached copy because the server could not be reached. */
  const [offlineMode, setOfflineMode] = useState(false)
  /** …and that cached copy is a PDF's extracted text. */
  const [cachedIsPdf, setCachedIsPdf] = useState(false)
  const [fileBusy, setFileBusy] = useState(false)
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
        setOfflineMode(false)
        try {
          setCached(await isUserBookFullyCached(id))
        } catch (err) {
          console.warn('isUserBookFullyCached failed:', err)
        }
      } catch (e) {
        console.error('Failed to load user book:', e)
        if (unmountedRef.current) return
        // Unreachable server, but the book may be on the device. Render the
        // downloaded copy rather than the "couldn't load" screen — this is the
        // whole point of having downloaded it.
        const rehydrated = await rehydrateFromCache(id)
        if (unmountedRef.current) return
        if (rehydrated) {
          setBook(rehydrated.book)
          setSavedProgress(rehydrated.progress)
          setCached(true)
          setOfflineMode(true)
          setCachedIsPdf(rehydrated.isPdf)
          setLoadError(null)
        } else {
          setLoadError(isOfflineError(e) ? 'offline' : 'failed')
        }
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
  //
  // Not on the first focus: the load effect has just fetched the progress, and
  // asking again here was a second GET on every open.
  useRefocusEffect(() => {
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
  })

  // Auto-refresh while processing OR while metadata enrichment is in flight —
  // one poll on GET /me/books/{id} serving both (there used to be two on the
  // same URL). Enrichment runs after 'ready' and the worker can't reach the
  // device, so we poll until a terminal state (Completed/Failed). Mirrors the
  // web detail page.
  //
  // Recursive setTimeout (not setInterval) for exponential backoff on repeated
  // failures, so an outage isn't hammered (P1-2). Guards against `id` going
  // undefined mid-flight (P0-1).
  const pollProcessing = book?.status.toLowerCase() === 'processing'
  const pollEnriching = book?.metadataEnrichmentStatus === 'Pending' || book?.metadataEnrichmentStatus === 'Running'
  useEffect(() => {
    if (pollTimeoutRef.current) {
      clearTimeout(pollTimeoutRef.current)
      pollTimeoutRef.current = null
    }
    if (!id) return
    if (!pollProcessing && !pollEnriching) return

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
        // A phase change (processing → ready, Pending → Running → done) re-runs
        // this effect via its deps, which restarts or tears down the loop. Only
        // keep ticking ourselves when nothing changed.
        const stillProcessing = b.status.toLowerCase() === 'processing'
        const stillEnriching = b.metadataEnrichmentStatus === 'Pending' || b.metadataEnrichmentStatus === 'Running'
        if (stillProcessing === pollProcessing && stillEnriching === pollEnriching) scheduleNext()
      } catch (err) {
        if (cancelled || unmountedRef.current) return
        consecutiveFailures += 1
        console.warn(`Poll ${consecutiveFailures} failed for user book ${id}:`, err)
        if (pollProcessing && consecutiveFailures === FAILURE_TOAST_THRESHOLD) {
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
  }, [pollProcessing, pollEnriching, id, showToast])

  // Download state for this book, if one has been started this session.
  const dl = book ? downloads.get(book.id) : undefined
  /** What the button is about to spend, when the server said — and only for a
   *  book whose original is actually fetched. The server reports the size of
   *  the newest stored file of ANY format, so an EPUB upload or an HTML clip
   *  has one too, while the download takes only their chapter text. */
  const downloadSize = book?.hasOriginalPdf === true
    ? formatBytes(typeof book.originalFileBytes === 'number' ? book.originalFileBytes : null)
    : null

  const isReady = book?.status.toLowerCase() === 'ready'
  const { insights, reviews, removeInsight } = useBookReviews(isReady && book ? { userBookId: book.id } : null)
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
            // The copy on THIS device goes with it. Deleting the book server-side
            // used to leave its downloaded original sitting in the app's
            // document directory — tens of megabytes of the reader's own private
            // file, belonging to a book that no longer exists, with nothing left
            // in the UI that could ever remove it. Found on a device, because
            // "Remove download" and "Delete book" are different buttons and only
            // the first one cleaned up.
            await removeUserBookDownload(id).catch(err => {
              console.warn('Clearing the local copy of a deleted book failed:', err)
            })
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

  /**
   * Give the reader back the file they uploaded.
   *
   * Two things used to be wrong here. The button opened the export URL in the
   * system browser — a process holding none of the app's credentials, against an
   * endpoint that requires a Bearer token, so every tap landed on a 401. And
   * what it asked for was a re-encoded EPUB of the extracted text, without the
   * images, while the original sat on the device untouched. It now shares the
   * original, from disk when the book is downloaded; see `src/lib/shareOriginal.ts`.
   */
  const handleShareOriginal = async () => {
    if (!id || fileBusy) return
    setFileBusy(true)
    try {
      // Uploads are EPUB or PDF and nothing else (`UserBookService.DetectFormat`
      // rejects the rest), so the one flag the payload carries settles it.
      const format = book?.hasOriginalPdf === true ? 'pdf' : 'epub'
      const outcome = await shareOriginalFile(id, book?.title ?? null, format)
      switch (outcome.status) {
        case 'shared':
          break
        case 'saved':
          showToast({ message: 'Saved to this device', variant: 'success', duration: 2600 })
          break
        case 'unauthorized':
          showToast({ message: 'Sign in again to get this file', variant: 'error', duration: 2800 })
          break
        case 'notfound':
          showToast({ message: 'The original file is no longer on the server', variant: 'error', duration: 2800 })
          break
        default:
          showToast({ message: 'Could not get the file', variant: 'error', duration: 2600 })
      }
    } finally {
      setFileBusy(false)
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

  const pages = bookPages(book)
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
              {pages && <Chip icon="document-text-outline" text={`${pages.exact ? '' : '~'}${plural(pages.pages, 'page', 'pages')}`} colors={colors} />}
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

        {offlineMode && (
          <OfflineBanner
            message={
              // A PDF whose original is stored offline opens as itself, so the
              // old wording ("the downloaded text") now contradicts the reader
              // one tap away. Only a PDF WITHOUT its file still reads as text.
              cachedIsPdf && book?.hasOriginalPdf !== true
                ? "You're offline — reading the downloaded text of this PDF."
                : "You're offline — reading the downloaded copy."
            }
          />
        )}

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
            <AssistantMenu
              book={{
                title: book.title,
                author: book.author,
                bookId: book.id,
                progressFraction: bookPct,
                chapterTitle: book.chapters.find(c => c.slug === continueSlug)?.title ?? null,
              }}
              current={currentReviewChapter(book.chapters, continueSlug, reviews)}
            >
              <TouchableOpacity
                style={[styles.readBtn, { backgroundColor: colors.primary }]}
                onPress={() => {
                  const first = book.chapters[0]
                  const slug = continueSlug || (first ? userBookChapterSlug(first) : '')
                  router.push(`/my-books/read/${id}/${slug}`)
                }}
              >
                <Ionicons name={continueSlug ? 'play' : 'book'} size={18} color="#fff" />
                <Text style={styles.readBtnText}>{continueSlug ? 'Continue Reading' : 'Start Reading'}</Text>
              </TouchableOpacity>
            </AssistantMenu>
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
            {/* Offline download. Same four states as a catalog book — the two
                libraries now share one download engine (DownloadContext). */}
            <DownloadButton
              dl={dl}
              cached={cached}
              onRemove={() => removeUserBookDownload(book.id).then(() => setCached(false))}
              onCancel={() => cancelDownload(book.id)}
              onRetry={() => retryFailed(book.id)}
              onStart={async () => {
                if (!(await confirmDownloadOnCellular(book))) return
                await startUserBookDownload(book)
                setCached(await isUserBookFullyCached(book.id).catch(() => false))
              }}
              startLabel={downloadSize ? `Download for Offline · ${downloadSize}` : 'Download for Offline'}
              buttonStyle={styles.secondaryBtn}
              textStyle={styles.secondaryBtnText}
            />

            {/* Said before the download, not discovered after it. It used to
                warn that an offline PDF opens as text; the download now takes
                the original file too, so the promise is the opposite one — and
                the honest part to state up front is the size. */}
            {book.hasOriginalPdf === true && !offlineMode && (
              <Text style={[styles.offlineNote, { color: colors.textSecondary }]}>
                Downloads the original pages, so this book looks the same offline.
              </Text>
            )}

            {/* Enabled offline when the book is on the device: the file is right
                there, and asking the server for a copy of it would be the exact
                round trip the offline work exists to remove. */}
            <TouchableOpacity
              style={[styles.secondaryBtn, { borderColor: colors.border, opacity: fileBusy ? 0.6 : 1 }]}
              onPress={handleShareOriginal}
              disabled={fileBusy || (offlineMode && !cached)}
              accessibilityRole="button"
              accessibilityLabel="Share the file you uploaded"
              accessibilityState={{ disabled: fileBusy || (offlineMode && !cached) }}
            >
              {fileBusy
                ? <ActivityIndicator size="small" color={colors.text} />
                : <Ionicons name="share-outline" size={18} color={colors.text} />}
              <Text style={[styles.secondaryBtnText, { color: colors.text }]}>
                {fileBusy ? 'Preparing…' : 'Share'}
              </Text>
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
        {isReady && <BookInsightsSection insights={insights} onRemoved={removeInsight} userBookId={book.id} />}

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
                  onPress={() => router.push(`/my-books/read/${id}/${userBookChapterSlug(ch)}?pick=1`)}
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
                  {/* A review is keyed by the real slug; a slugless legacy chapter cannot be reviewed. */}
                  {!!ch.slug?.trim() && (
                    <ChapterReviewAction
                      book={{ title: book.title, author: book.author, userBookId: book.id }}
                      chapter={{ slug: ch.slug, title: ch.title, wordCount: ch.wordCount }}
                      reviewed={reviews.has(ch.slug)}
                    />
                  )}
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
  offlineNote: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 17, paddingHorizontal: 2, marginTop: -2 },
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
