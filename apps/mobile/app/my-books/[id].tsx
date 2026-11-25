import { useEffect, useState, useRef } from 'react'
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator, Alert } from 'react-native'
import { Image } from 'expo-image'
import { useLocalSearchParams, useRouter, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import NetInfo from '@react-native-community/netinfo'
import { ApiError, currentReviewChapter, storedBookPercent, formatBookPercent, resumeChapterSlug, isOfflineError, plural, bookPages } from '@textstack/shared'
import { userBooksApi } from '../../src/lib/userBooksApi'
import { logLoadError } from '../../src/lib/logLoadError'
import type { UserBookDetailResponse } from '@textstack/shared'
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
import { shouldConfirmOnCellular } from '../../src/lib/originalFilePolicy'
import { formatBytes } from '../../src/lib/formatBytes'
import { deviceLocalLibrary } from '../../src/lib/reader/deviceLibrary'
import { deleteBook } from '../../src/lib/reader/deviceDownload'
import { failedLoadView } from '../../src/lib/deletedOnServer'
import { userBookChapterSlug } from '../../src/lib/userBookChapters'
import { DownloadButton } from '../../src/components/library/DownloadButton'
import { BookInsightsSection } from '../../src/components/library/BookInsightsSection'
import { AssistantMenu } from '../../src/components/library/AssistantMenu'
import { useBookReviews } from '../../src/hooks/useBookReviews'
import { useRefocusEffect } from '../../src/hooks/useRefocusEffect'
import { useCoverSource } from '../../src/hooks/useCoverSource'

/**
 * Everything this screen needs, read off the device: the book whose file is here and its last place
 * (the V2 local library, #1532). Null when the file is not on this device (or on web).
 */
async function rehydrateFromDevice(bookId: string): Promise<{
  book: UserBookDetailResponse
  progress: { chapterSlug: string | null; percent: number | null; locator: string | null } | null
} | null> {
  try {
    const lib = deviceLocalLibrary()
    const here = (await lib.books()).find(b => b.id === bookId && b.local)
    if (!here) return null
    const place = (await lib.progress()).get(bookId)
    return {
      book: cachedUserBookDetail(here),
      // The V2 reader resumes from its own place; the screen needs only how far in.
      progress: place ? { chapterSlug: null, percent: place.fraction, locator: null } : null,
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
  const [coverSource, onCoverError] = useCoverSource(book?.coverPath)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<'offline' | 'failed' | 'notfound' | null>(null)
  const [attempt, setAttempt] = useState(0)
  const reconnects = useReconnectCount()
  const [savedProgress, setSavedProgress] = useState<{ chapterSlug: string | null; percent: number | null; locator: string | null } | null>(null)
  const [deleting, setDeleting] = useState(false)
  const { onDevice, downloading, download, refreshOnDevice, syncDevice } = useDownload()
  // Its file is on the device (the V2 local library): what "Downloaded" means.
  const cached = !!id && onDevice.has(id)
  /** Rendering the device's copy because the server could not be reached. */
  const [offlineMode, setOfflineMode] = useState(false)
  const [fileBusy, setFileBusy] = useState(false)
  const unmountedRef = useRef(false)

  useEffect(() => {
    unmountedRef.current = false
    return () => { unmountedRef.current = true }
  }, [])

  useEffect(() => {
    if (!id) return
    // A newer run (reconnect, Retry) supersedes this one: it must not overwrite that run's state,
    // nor record an answer that is no longer the latest.
    let stale = false
    const live = () => !stale && !unmountedRef.current
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
        if (!live()) return
        setBook(b)
        if (p) setSavedProgress({ chapterSlug: p.chapterSlug, percent: p.percent, locator: p.locator ?? null })
        setLoadError(null)
        setOfflineMode(false)
      } catch (e) {
        // Confirmed 404: the upload was deleted on the server (#1164). Say so
        // instead of presenting the cached copy as live.
        const notFound = e instanceof ApiError && e.status === 404
        if (notFound) console.warn('User book not found:', e)
        else logLoadError('Failed to load user book:', e)
        if (!live()) return
        // Unreachable server, but the book may be on the device. Render the
        // downloaded copy rather than the "couldn't load" screen — this is the
        // whole point of having downloaded it.
        const rehydrated = notFound ? null : await rehydrateFromDevice(id)
        if (!live()) return
        const view = failedLoadView({ notFound, hasCopy: rehydrated !== null, offline: isOfflineError(e) })
        switch (view) {
          case 'notfound':
            setBook(null)
            setOfflineMode(false)
            setLoadError('notfound')
            break
          case 'cached':
            setBook(rehydrated!.book)
            setSavedProgress(rehydrated!.progress)
            setOfflineMode(true)
            setLoadError(null)
            break
          case 'offline':
          case 'failed':
            setLoadError(view)
        }
      } finally {
        if (live()) setLoading(false)
      }
    })()
    return () => { stale = true }
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
  // change by reading it; the only thing that changes the progress is the user
  // leaving the reader, which is a focus event.
  //
  // Not on the first focus: the load effect has just fetched the progress, and
  // asking again here was a second GET on every open.
  useRefocusEffect(() => {
    if (!id) return
    // Back from the reader, which fetches the book it opens: "Downloaded" reads the device again.
    refreshOnDevice().catch(() => {})
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

  /** What the button is about to spend, when the server said (a PDF's file size). */
  const downloadSize = book?.hasOriginalPdf === true
    ? formatBytes(typeof book.originalFileBytes === 'number' ? book.originalFileBytes : null)
    : null

  const isReady = book?.status.toLowerCase() === 'ready'
  const { insights, reviews } = useBookReviews(isReady && book ? book.id : null)
  const isFailed = book?.status.toLowerCase() === 'failed'

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
            // #1189: off this device at once, offline too; the server's removal goes with the pass.
            await deleteBook(id, refreshOnDevice, () => { syncDevice().catch(() => {}) })
            // Don't reset `deleting` on success — the screen unmounts on router.back()
            // and any lingering state change would warn. (P2-2)
            router.back()
          } catch (err) {
            console.warn('deleteBook failed:', err)
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
      // The server holds it now; the device's library takes it on its next pass, so an offline cold start
      // still shows it read (#1552). Best effort: the reader's next open runs the same pass.
      syncDevice().catch(() => {})
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
      const outcome = await shareOriginalFile(id, book?.title ?? null)
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
          {/* 'notfound' keeps Retry: a successful load undoes it. */}
          <EmptyState
            icon={loadError === 'notfound' ? 'help-circle-outline' : loadError === 'offline' ? 'cloud-offline-outline' : 'alert-circle-outline'}
            title={loadError === 'notfound' ? t('myBooks.deleted.title') : loadError === 'offline' ? t('library.offline.title') : t('library.loadFailed.title')}
            subtitle={loadError === 'notfound'
              ? t('myBooks.deleted.bodyNoCopy')
              : loadError === 'offline' ? t('library.offline.body') : t('library.loadFailed.body')}
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
  // #1532: a V2 place names no chapter (a PDF at 50% has no slug), so how far in counts too.
  const started = !!continueSlug || (bookPct ?? 0) > 0

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
            source={coverSource}
            onError={onCoverError}
            style={[styles.cover, { backgroundColor: colors.border }]}
            contentFit="cover"
          />
          <View style={styles.meta}>
            <Text style={[styles.title, { color: colors.text }]}>{book.title || 'Untitled'}</Text>
            {book.author && <Text style={[styles.author, { color: colors.textSecondary }]}>{book.author}</Text>}

            {/* Metadata chips */}
            <View style={styles.chipRow}>
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
            message="You're offline — reading the downloaded copy."
          />
        )}

        {/* Description */}
        {book.description && (
          <View style={styles.descSection}>
            <Text style={[styles.descText, { color: colors.textSecondary }]}>{book.description}</Text>
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

        {/* Action buttons */}
        {/* V2 reads the raw file (queued, processing or failed extraction alike) once its bytes are in. Unknown (an
            offline copy cached before `hasFile`): chapters on the device mean the book was readable. No network. */}
        {(book.hasFile ?? book.chapters.length > 0) && (
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
                  // `start`: a V2 book with no chapter yet (the V2 reader ignores the slug).
                  const slug = continueSlug || (first ? userBookChapterSlug(first) : 'start')
                  router.push(`/my-books/read/${id}/${slug}`)
                }}
              >
                <Ionicons name={started ? 'play' : 'book'} size={18} color="#fff" />
                <Text style={styles.readBtnText}>{started ? 'Continue Reading' : 'Start Reading'}</Text>
              </TouchableOpacity>
            </AssistantMenu>
            {/* The book's own contents, in the reader (its Contents sheet opens with the book). */}
            <TouchableOpacity
              style={[styles.secondaryBtn, { borderColor: colors.border }]}
              onPress={() => router.push(`/my-books/read/${id}/start?contents=1`)}
              accessibilityRole="button"
            >
              <Ionicons name="list-outline" size={18} color={colors.text} />
              <Text style={[styles.secondaryBtnText, { color: colors.text }]}>{t('reader.chrome.contents')}</Text>
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
            {/* Offline download: the book's file to this device (DownloadContext). */}
            <DownloadButton
              cached={cached}
              downloading={downloading.has(book.id)}
              onStart={async () => {
                if (!(await confirmDownloadOnCellular(book))) return
                const here = await download(book.id).catch(() => false)
                if (!here) showToast({ message: "Couldn't download this book. Try again.", variant: 'error', duration: 2600 })
              }}
              startLabel={downloadSize ? `Download for Offline · ${downloadSize}` : 'Download for Offline'}
              buttonStyle={styles.secondaryBtn}
              textStyle={styles.secondaryBtnText}
            />

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
          </View>
        )}

        {/* Above the chapter list on purpose: coming back to a book, what you
            already worked out is more use than the table of contents. */}
        {isReady && <BookInsightsSection insights={insights} />}

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
  return null
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
  progressSection: { paddingHorizontal: 16, marginBottom: 12 },
  progressTrack: { height: 6, borderRadius: 3, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 3 },
  errorBox: { marginHorizontal: 16, marginBottom: 12, padding: 12, borderRadius: 8, borderWidth: 1, flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
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
