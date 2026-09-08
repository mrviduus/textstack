import { useCallback, useEffect, useRef, useState } from 'react'
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Share } from 'react-native'
import { Image } from 'expo-image'
import { useFocusEffect, useLocalSearchParams, useRouter, Stack } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { createBooksApi, formatBookPercent, getStorageUrl, libraryApi, plural, readingProgressApi, resumeChapterSlug, storedBookPercent } from '@textstack/shared'
import type { BookDetail } from '@textstack/shared'
import { useDownload } from '../../src/context/DownloadContext'
import { useAuth } from '../../src/context/AuthContext'
import { useTheme } from '../../src/context/ThemeContext'
import { useLanguage } from '../../src/context/LanguageContext'
import { useToast } from '../../src/context/ToastContext'
import { AddToCollectionSheet } from '../../src/components/library/AddToCollectionSheet'
import { BookInsightsSection } from '../../src/components/library/BookInsightsSection'
import { DiscussWithAssistant } from '../../src/components/library/DiscussWithAssistant'
import { useSheetMount } from '../../src/hooks/useSheetMount'
import {
  isBookFullyCached,
  getAllCachedBooks,
  listCachedChapters,
} from '../../src/lib/offlineDb'
import { getLocalProgress } from '../../src/lib/progressStorage'
import { fonts } from '../../src/theme/typography'
import { OfflineBanner } from '../../src/components/ui/OfflineBanner'
import { SkeletonLoader } from '../../src/components/ui/SkeletonLoader'

export default function BookDetailScreen() {
  const { slug } = useLocalSearchParams<{ slug: string }>()
  const router = useRouter()
  const { isAuthenticated } = useAuth()
  const { colors } = useTheme()
  const { language, t } = useLanguage()
  const toast = useToast()
  const { downloads, startDownload, cancelDownload, removeDownload, retryFailed } = useDownload()
  const [book, setBook] = useState<BookDetail | null>(null)
  const [bookLoading, setBookLoading] = useState(true)
  /**
   * Have the session-dependent follow-ups (library membership + progress)
   * answered yet?
   *
   * A one-way latch, never set back to `true`. It exists because the single
   * `loading` flag used to cover BOTH round-trips: library and progress were
   * awaited inside `getBook`'s own `.then`, so the skeleton stayed up until the
   * hero could be painted with the right button. Splitting the fetches into two
   * effects (see below) would otherwise paint "Start Reading" for one RTT on a
   * book the reader is 40% through.
   *
   * Seeded from `isAuthenticated` at mount, so a signed-out reader is never
   * held for a fetch that will not happen; and because it is never re-raised, a
   * session that arrives later (guest minting inside the reader) refreshes the
   * data underneath without throwing this screen back to a skeleton.
   */
  const [sessionLoading, setSessionLoading] = useState(isAuthenticated)
  // `book != null` so a failed load falls through to the error screen instead
  // of sitting on a skeleton forever waiting for follow-ups that never run.
  const loading = bookLoading || (sessionLoading && book != null)
  const [fetchError, setFetchError] = useState<string | null>(null)
  const [cached, setCached] = useState(false)
  const [inLibrary, setInLibrary] = useState(false)
  const [collectionSheetOpen, setCollectionSheetOpen] = useState(false)
  // Not mounted until first opened — see useSheetMount. This screen is public,
  // so the sheet's `useCollections` was 401ing on every open for a signed-out
  // reader.
  const collectionSheetMounted = useSheetMount(collectionSheetOpen)
  const [continueSlug, setContinueSlug] = useState<string | null>(null)
  // How far in the reader is, so the button says where it will take them. The shelf card already
  // showed "11% complete" while this screen offered a bare "Continue Reading" — the same reader,
  // the same book, one of the two screens keeping it to itself.
  const [continuePct, setContinuePct] = useState<number | null>(null)
  /**
   * The edition id whose session data has already been loaded once. The focus
   * refresh below uses it to tell "the screen just came back into view" apart
   * from "the initial load has not finished yet", which is the difference
   * between a useful refetch and a duplicate one.
   */
  const progressLoadedForRef = useRef<string | null>(null)
  const [showAllChapters, setShowAllChapters] = useState(false)
  // True when the page is rendering a minimal view built from the offline
  // SQLite cache because the server was unreachable. Used to hide
  // server-only affordances (ratings, reviews, library toggle) that
  // require round-trips the device can't make right now (R-4).
  const [offlineMode, setOfflineMode] = useState(false)
  // Bump to force a refetch when the user presses Retry (P1-4).
  const [reloadTick, setReloadTick] = useState(0)

  /**
   * The public book. Deliberately NOT keyed on `isAuthenticated`.
   *
   * It used to be, and the session-dependent follow-ups lived inside this
   * `.then`. That made a guest's first book open fetch `GET /books/{slug}`
   * twice: `ReaderSessionGate` mints an anonymous session the moment the reader
   * mounts, `isAuthenticated` flips false→true GLOBALLY, and this screen is
   * still mounted underneath (the reader is pushed, not replaced) — so it
   * re-fetched the same public book at the exact moment the gate was fetching
   * it for the reader. `readerSessionGate.ts` freezes `isAuthenticated` for the
   * reader's own lifetime; nothing freezes it for the screens behind it.
   *
   * The book does not change when a session appears, so a session appearing is
   * not a reason to re-fetch it. Only what actually depends on the session
   * moves, into the effect below.
   */
  useEffect(() => {
    if (!slug) return
    let cancelled = false
    setBookLoading(true)
    setFetchError(null)
    setOfflineMode(false)
    const api = createBooksApi(language)
    api.getBook(slug)
      .then(async (b) => {
        if (cancelled) return
        setBook(b)
        try {
          setCached(await isBookFullyCached(b.id))
        } catch (err) {
          console.warn('isBookFullyCached failed:', err)
        }
      })
      .catch(async (e) => {
        if (cancelled) return
        console.error('Failed to load book:', e)
        const status: number | undefined = e?.status
        // Confirmed 404 → stop; the book really doesn't exist server-side.
        if (status === 404) {
          setFetchError('notfound')
          return
        }
        // Network / transient server failure — try to rehydrate from the
        // offline cache so a fully downloaded book stays usable while the
        // device is offline (R-4). `slug` in cache is the edition slug so
        // we match directly.
        try {
          const cachedBooks = await getAllCachedBooks()
          if (cancelled) return
          const meta = cachedBooks.find(c => c.slug === slug) ?? null
          if (!meta) {
            setFetchError('generic')
            return
          }
          const [cachedChapters, localProgress] = await Promise.all([
            listCachedChapters(meta.editionId),
            getLocalProgress(meta.editionId),
          ])
          if (cancelled) return
          const offlineBook: BookDetail = {
            id: meta.editionId,
            slug: meta.slug,
            title: meta.title,
            description: null,
            coverPath: meta.coverPath,
            language,
            authors: [],
            genre: null,
            chapters: cachedChapters.map((c, idx) => ({
              id: `${meta.editionId}:${c.slug}`,
              chapterNumber: idx + 1,
              slug: c.slug,
              title: c.title,
              wordCount: c.wordCount,
            })),
            otherEditions: [],
            moreByAuthor: [],
          } as unknown as BookDetail
          setBook(offlineBook)
          setCached(meta.cachedChapters >= meta.totalChapters)
          setOfflineMode(true)
          if (localProgress?.chapterSlug) setContinueSlug(localProgress.chapterSlug)
        } catch (cacheErr) {
          if (!cancelled) {
            console.warn('Offline fallback failed:', cacheErr)
            setFetchError('generic')
          }
        }
      })
      .finally(() => {
        if (!cancelled) setBookLoading(false)
      })

    return () => { cancelled = true }
  }, [slug, language, reloadTick])

  /**
   * Everything that only makes sense once there is a session: is this book on
   * the shelf, and how far in is the reader. Keyed on the book id and on
   * `isAuthenticated`, so a session arriving mid-life (the guest mint above)
   * refreshes exactly this and nothing else.
   *
   * Skipped in offline mode: `book` there is a stub assembled from the SQLite
   * cache because the server was unreachable, and these are the two calls that
   * cannot be made.
   */
  useEffect(() => {
    const editionId = book?.id
    // No book yet: `bookLoading` is still holding the skeleton, so there is
    // nothing to release and nothing to fetch.
    if (!editionId) return
    if (!isAuthenticated || offlineMode) {
      // Nothing will be fetched, so the question is already answered — and the
      // focus refresh below is still armed (offline it re-reads local progress).
      progressLoadedForRef.current = editionId
      setSessionLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      // Library + progress are non-fatal for the detail page — if they fail we
      // still render the book, just without the saved/continue state. We log
      // the error instead of swallowing silently (P1-4/P3-2).
      try {
        const lib = await libraryApi.getLibrary()
        if (!cancelled) setInLibrary(lib.some(item => item.editionId === editionId))
      } catch (err) {
        console.warn('getLibrary failed on book detail:', err)
      }
      try {
        const p = await readingProgressApi.getProgress(editionId)
        // Not `p?.chapterSlug` alone: a PDF read in Original layout is
        // chapterless, its position is a `page:<N>` locator, and looking
        // only at the slug made every half-read PDF report "never opened".
        // `my-books/[id].tsx` already carries this fallback; the catalog
        // screen did not.
        if (!cancelled) {
          const resume = resumeChapterSlug(p?.chapterSlug, p?.locator, book?.chapters)
          if (resume) setContinueSlug(resume)
          setContinuePct(storedBookPercent(p))
        }
      } catch (err) {
        console.warn('getProgress failed on book detail:', err)
      }
      if (!cancelled) {
        // Whatever happened, the question "has the session data landed" is now
        // answered — drop the skeleton. Marking the id lets the focus refresh
        // below tell a re-entry apart from this first pass.
        progressLoadedForRef.current = editionId
        setSessionLoading(false)
      }
    })()
    return () => { cancelled = true }
    // `book?.chapters` is read inside but deliberately not a dep: it is fixed
    // for a given edition id, and listing the array would re-run this on every
    // book object identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [book?.id, isAuthenticated, offlineMode])

  /**
   * Re-read the progress when this screen comes back into view.
   *
   * The reader is pushed and left with `router.back()`, so this screen is never
   * unmounted and neither effect above re-runs — none of their deps change. QA
   * read a chapter, backed out, and met "Start Reading" and the pre-reader
   * percentage on a book they had just moved through. The write side was fine;
   * only the read was stale. Same fix, same shape, as `my-books/[id].tsx`.
   *
   * Only the progress, not the book: a book's own fields do not change by
   * reading it.
   *
   * `progressLoadedForRef` is the guard against racing the initial load. This
   * callback's identity changes when the book id lands, which re-runs it while
   * still focused — at that moment the effect above has not answered yet, the
   * ref does not match, and this returns rather than firing a second
   * `GET /me/progress/{id}`. It only starts doing work on a genuine re-focus.
   */
  useFocusEffect(
    useCallback(() => {
      const editionId = book?.id
      if (!editionId || progressLoadedForRef.current !== editionId) return
      let cancelled = false
      if (offlineMode) {
        // Offline the reader still writes progress locally, so the same
        // staleness applies — it is just answered from AsyncStorage. Mirrors
        // the offline branch of the load effect, which sets the slug only.
        getLocalProgress(editionId)
          .then(local => {
            if (cancelled || !local?.chapterSlug) return
            setContinueSlug(local.chapterSlug)
          })
          .catch(() => {})
        return () => { cancelled = true }
      }
      if (!isAuthenticated) return
      readingProgressApi.getProgress(editionId)
        .then(p => {
          if (cancelled || !p) return
          const resume = resumeChapterSlug(p.chapterSlug, p.locator, book?.chapters)
          if (resume) setContinueSlug(resume)
          setContinuePct(storedBookPercent(p))
        })
        // Offline, or the request failed: keep whatever the screen already
        // shows rather than blanking a good value with a failed refresh.
        .catch(() => {})
      return () => { cancelled = true }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [book?.id, isAuthenticated, offlineMode]),
  )

  const dl = book ? downloads.get(book.id) : undefined
  const isDownloading = dl?.status === 'downloading'
  const progress = dl ? Math.round((dl.downloadedChapters / dl.totalChapters) * 100) : 0

  if (loading) {
    return (
      <>
        <Stack.Screen options={{ title: '', headerShown: true, headerStyle: { backgroundColor: colors.background }, headerShadowVisible: false }} />
        <View style={[styles.container, { backgroundColor: colors.background }]}>
          <View style={styles.header}>
            <SkeletonLoader width={160} height={240} borderRadius={8} />
          </View>
          <View style={{ paddingHorizontal: 16, gap: 8 }}>
            <SkeletonLoader width="60%" height={24} />
            <SkeletonLoader width="40%" height={16} />
            <SkeletonLoader width="100%" height={48} borderRadius={10} style={{ marginTop: 16 }} />
          </View>
        </View>
      </>
    )
  }

  if (fetchError || !book) {
    const isNotFound = fetchError === 'notfound'
    return (
      <>
        <Stack.Screen options={{ title: '', headerShown: true, headerStyle: { backgroundColor: colors.background }, headerTintColor: colors.text, headerShadowVisible: false }} />
        <View style={[styles.container, styles.errorWrap, { backgroundColor: colors.background }]}>
          <Ionicons
            name={isNotFound ? 'help-circle-outline' : 'cloud-offline-outline'}
            size={56}
            color={colors.textSecondary}
          />
          <Text style={[styles.errorTitle, { color: colors.text }]}>
            {isNotFound ? "We couldn't find this book" : "Couldn't load this book"}
          </Text>
          <Text style={[styles.errorBody, { color: colors.textSecondary }]}>
            {isNotFound
              ? 'It may have been removed or the link is outdated.'
              : 'Check your connection and try again.'}
          </Text>
          {!isNotFound && (
            <TouchableOpacity
              style={[styles.readButton, { backgroundColor: colors.primary, marginTop: 20, paddingHorizontal: 28 }]}
              onPress={() => setReloadTick(t => t + 1)}
              accessibilityLabel="Retry loading"
              accessibilityRole="button"
              activeOpacity={0.85}
            >
              <Ionicons name="refresh" size={18} color="#fff" />
              <Text style={styles.readButtonText}>Retry</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={{ marginTop: 12, paddingVertical: 8, paddingHorizontal: 16 }}
            onPress={() => router.back()}
            accessibilityLabel="Go back"
            accessibilityRole="button"
          >
            <Text style={{ color: colors.primary, fontFamily: fonts.sansMedium, fontSize: 14 }}>Go back</Text>
          </TouchableOpacity>
        </View>
      </>
    )
  }

  return (
    <>
      <Stack.Screen options={{
        title: book.title,
        headerShown: true,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerTitleStyle: { fontFamily: fonts.sansMedium, fontSize: 16 },
        headerShadowVisible: false,
      }} />
      <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
        {/* Hero */}
        <View style={styles.hero}>
          <View style={styles.coverWrapper}>
            <Image source={getStorageUrl(book.coverPath)} style={[styles.cover, { backgroundColor: colors.border }]} contentFit="cover" />
          </View>
          <Text style={[styles.title, { color: colors.text }]}>{book.title}</Text>
          {book.authors.length > 0 && (
            <Text style={[styles.authors, { color: colors.textSecondary }]}>
              {book.authors.map(a => a.name).join(', ')}
            </Text>
          )}
          <View style={styles.metaRow}>
            <Ionicons name="document-text-outline" size={14} color={colors.textSecondary} />
            <Text style={[styles.metaText, { color: colors.textSecondary }]}>{plural(book.chapters.length, 'chapter', 'chapters')}</Text>
          </View>
        </View>

        {offlineMode && <OfflineBanner message="You're offline — showing downloaded content only." />}

        {book.description && (
          <Text style={[styles.description, { color: colors.text }]}>{book.description}</Text>
        )}

        {/* Actions */}
        <View style={styles.actions}>
          {continueSlug && continuePct != null && (
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text style={{ fontSize: 13, color: colors.textSecondary, fontFamily: fonts.sans }}>
                {t('library.readingProgress')}
              </Text>
              <Text style={{ fontSize: 13, color: colors.primary, fontFamily: fonts.sansMedium }}>
                {formatBookPercent(continuePct)}
              </Text>
            </View>
          )}
          {book.chapters.length > 0 && (
            <TouchableOpacity
              style={[styles.readButton, { backgroundColor: colors.primary }]}
              onPress={() => {
                const target = continueSlug || book.chapters[0].slug
                router.push(`/reader/${slug}/${target}`)
              }}
              activeOpacity={0.85}
            >
              <Ionicons name={continueSlug ? 'play' : 'book-outline'} size={18} color="#fff" />
              <Text style={styles.readButtonText}>
                {continueSlug ? 'Continue Reading' : 'Start Reading'}
              </Text>
            </TouchableOpacity>
          )}

          {isAuthenticated && !offlineMode && (
            <TouchableOpacity
              style={[styles.secondaryButton, { borderColor: inLibrary ? colors.success : colors.primary }]}
              onPress={async () => {
                // Optimistic flip — roll back on failure so the button doesn't
                // lie about the library state.
                const wasInLibrary = inLibrary
                setInLibrary(!wasInLibrary)
                try {
                  if (wasInLibrary) {
                    await libraryApi.removeFromLibrary(book.id)
                  } else {
                    await libraryApi.addToLibrary(book.id)
                  }
                  // Library membership changed — drop the cached shelves so the
                  // book appears in / disappears from the shelves on next focus.
                } catch (err) {
                  console.warn('library toggle failed:', err)
                  setInLibrary(wasInLibrary)
                }
              }}
              activeOpacity={0.85}
            >
              <Ionicons name={inLibrary ? 'checkmark-circle' : 'add-circle-outline'} size={18} color={inLibrary ? colors.success : colors.primary} />
              <Text style={[styles.secondaryButtonText, { color: inLibrary ? colors.success : colors.primary }]}>
                {inLibrary ? 'In Library' : 'Save to Library'}
              </Text>
            </TouchableOpacity>
          )}

          {offlineMode ? (
            // Cached-only view: the only thing that makes sense is
            // "remove download" — other states need a fresh book payload
            // we can't fetch right now.
            <TouchableOpacity style={[styles.secondaryButton, { borderColor: colors.success }]} onPress={() => removeDownload(book.id)} activeOpacity={0.85}>
              <Ionicons name="cloud-done-outline" size={18} color={colors.success} />
              <Text style={[styles.secondaryButtonText, { color: colors.success }]}>Downloaded — Remove</Text>
            </TouchableOpacity>
          ) : cached ? (
            <TouchableOpacity style={[styles.secondaryButton, { borderColor: colors.success }]} onPress={() => removeDownload(book.id)} activeOpacity={0.85}>
              <Ionicons name="cloud-done-outline" size={18} color={colors.success} />
              <Text style={[styles.secondaryButtonText, { color: colors.success }]}>Downloaded — Remove</Text>
            </TouchableOpacity>
          ) : isDownloading ? (
            <TouchableOpacity style={[styles.secondaryButton, { borderColor: colors.primary }]} onPress={() => cancelDownload(book.id)} activeOpacity={0.85}>
              <Ionicons name="cloud-download-outline" size={18} color={colors.primary} />
              <Text style={[styles.secondaryButtonText, { color: colors.primary }]}>Downloading {progress}% — Cancel</Text>
            </TouchableOpacity>
          ) : dl?.status === 'error' && dl.failedChapters > 0 ? (
            <>
              <TouchableOpacity style={[styles.secondaryButton, { borderColor: '#F59E0B' }]} onPress={() => retryFailed(book.id)} activeOpacity={0.85}>
                <Ionicons name="refresh" size={18} color="#F59E0B" />
                <Text style={[styles.secondaryButtonText, { color: '#F59E0B' }]}>
                  {plural(dl.failedChapters, 'chapter', 'chapters', 'Retry {n} failed {noun}')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.secondaryButton, { borderColor: colors.border }]} onPress={() => startDownload(book, language)} activeOpacity={0.85}>
                <Ionicons name="refresh-circle-outline" size={18} color={colors.textSecondary} />
                <Text style={[styles.secondaryButtonText, { color: colors.text }]}>Re-download from scratch</Text>
              </TouchableOpacity>
            </>
          ) : (
            <TouchableOpacity style={[styles.secondaryButton, { borderColor: colors.border }]} onPress={() => startDownload(book, language)} activeOpacity={0.85}>
              <Ionicons name="download-outline" size={18} color={colors.textSecondary} />
              <Text style={[styles.secondaryButtonText, { color: colors.text }]}>Download for Offline</Text>
            </TouchableOpacity>
          )}
        </View>

        {/*
          Share only. Public-book EPUB download was deprecated on the web
          2026-04-15 (see CLAUDE.md) — the backend route still responds but
          the UI anchor is gone. Mobile aligns: button removed to avoid
          surfacing a dead path to users. If re-enabled, open the URL
          `${baseUrl}/${language}/books/${slug}/export/epub` via Linking
          wrapped in try/catch + toast on failure (B-76).
        */}
        <View style={{ paddingHorizontal: 16, marginBottom: 16, gap: 10 }}>
          {inLibrary && (
            <TouchableOpacity
              style={[styles.secondaryButton, { borderColor: colors.border }]}
              onPress={() => setCollectionSheetOpen(true)}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={t('library.actions.addToCollection')}
            >
              <Ionicons name="folder-outline" size={18} color={colors.text} />
              <Text style={[styles.secondaryButtonText, { color: colors.text }]}>{t('library.actions.addToCollection')}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={[styles.secondaryButton, { borderColor: colors.border }]}
            onPress={async () => {
              try {
                // Use the current UI language for the shared link so a Ukrainian
                // user shares the Ukrainian URL, not hardcoded `/en/`.
                await Share.share({
                  message: `${book.title} — Read on TextStack: https://textstack.app/${language}/books/${slug}`,
                })
              } catch (e) {
                console.warn('Share failed:', e)
                toast.show({ message: 'Could not open share sheet', variant: 'error' })
              }
            }}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={`Share ${book.title}`}
          >
            <Ionicons name="share-outline" size={18} color={colors.text} />
            <Text style={[styles.secondaryButtonText, { color: colors.text }]}>Share</Text>
          </TouchableOpacity>
        </View>

        {collectionSheetMounted && <AddToCollectionSheet
          visible={collectionSheetOpen}
          bookId={book.id}
          bookType="savedbook"
          onClose={() => setCollectionSheetOpen(false)}
          onAdded={(name) => toast.show({ message: t('library.actions.addedToCollection').replace('{{name}}', name), variant: 'success' })}
        />}

        {/* Same two panels as an uploaded book's screen — a conclusion written back
            over MCP can name either book type, so both have to show it or catalog
            insights would be write-only. Behind isAuthenticated because a signed-out
            reader would only be firing a 401 at every book they open. */}
        {isAuthenticated && <BookInsightsSection editionId={book.id} />}
        {isAuthenticated && (
          <DiscussWithAssistant
            title={book.title}
            author={book.authors.map(a => a.name).join(', ') || null}
            editionId={book.id}
          />
        )}

        <Text style={[styles.sectionTitle, { color: colors.text }]}>Chapters</Text>
        {(showAllChapters ? book.chapters : book.chapters.slice(0, 10)).map((ch) => (
          <TouchableOpacity
            key={ch.id}
            style={[styles.chapterItem, { borderBottomColor: colors.border }]}
            onPress={() => router.push(`/reader/${slug}/${ch.slug}`)}
            activeOpacity={0.7}
          >
            <Text style={[styles.chapterNumber, { color: colors.textSecondary }]}>{ch.chapterNumber}</Text>
            <View style={{ flex: 1 }}>
              <Text style={[styles.chapterTitle, { color: colors.text }]} numberOfLines={1}>{ch.title}</Text>
              {ch.wordCount != null && ch.wordCount > 0 && (
                <Text style={{ fontFamily: fonts.sans, fontSize: 11, color: colors.textSecondary, marginTop: 2 }}>
                  {Math.round(ch.wordCount / 1000)}k words · ~{Math.ceil(ch.wordCount / 250)} min
                </Text>
              )}
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
          </TouchableOpacity>
        ))}
        {book.chapters.length > 10 && !showAllChapters && (
          <TouchableOpacity
            style={{ paddingHorizontal: 16, paddingVertical: 12, alignItems: 'center' }}
            onPress={() => setShowAllChapters(true)}
          >
            <Text style={{ fontFamily: fonts.sansMedium, fontSize: 14, color: colors.primary }}>
              {plural(book.chapters.length, 'chapter', 'chapters', 'View all {n} {noun}')}
            </Text>
          </TouchableOpacity>
        )}

        {/* Author section */}
        {book.authors.length > 0 && (
          <View style={{ paddingHorizontal: 16, marginTop: 24 }}>
            <Text style={[styles.sectionTitle, { color: colors.text, paddingHorizontal: 0 }]}>About the Author</Text>
            {book.authors.map(a => (
              <TouchableOpacity
                key={a.slug}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}
                onPress={() => router.push(`/author/${a.slug}`)}
              >
                <Ionicons name="person-outline" size={18} color={colors.primary} />
                <Text style={{ fontFamily: fonts.sansMedium, fontSize: 15, color: colors.primary }}>{a.name}</Text>
                <Ionicons name="chevron-forward" size={14} color={colors.textSecondary} />
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* More by Author */}
        {book.moreByAuthor && book.moreByAuthor.length > 0 && (
          <View style={{ paddingHorizontal: 16, marginTop: 20 }}>
            <Text style={[styles.sectionTitle, { color: colors.text, paddingHorizontal: 0 }]}>More by Author</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginTop: 8 }}>
              {book.moreByAuthor.map(b => (
                <TouchableOpacity
                  key={b.id}
                  style={{ width: 100, marginRight: 12 }}
                  onPress={() => router.push(`/book/${b.slug}`)}
                  activeOpacity={0.7}
                >
                  <Image
                    source={b.coverPath ? getStorageUrl(b.coverPath) : undefined}
                    style={{ width: 100, height: 150, borderRadius: 6, backgroundColor: colors.border }}
                    contentFit="cover"
                  />
                  <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.text, marginTop: 6 }} numberOfLines={2}>{b.title}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          </View>
        )}

        {/* Other Editions */}
        {book.otherEditions.length > 0 && (
          <View style={{ paddingHorizontal: 16, marginTop: 20 }}>
            <Text style={[styles.sectionTitle, { color: colors.text, paddingHorizontal: 0 }]}>Other Editions</Text>
            {book.otherEditions.map(ed => (
              <TouchableOpacity
                key={ed.slug}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 8 }}
                onPress={() => router.push(`/book/${ed.slug}`)}
              >
                <Ionicons name="globe-outline" size={16} color={colors.primary} />
                <Text style={{ fontFamily: fonts.sans, fontSize: 14, color: colors.primary }}>
                  {ed.title} ({ed.language.toUpperCase()})
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: { alignItems: 'center', padding: 16 },
  hero: { alignItems: 'center', paddingHorizontal: 16, paddingTop: 8, paddingBottom: 20 },
  coverWrapper: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.15,
    shadowRadius: 16,
    elevation: 6,
    marginBottom: 16,
  },
  cover: { width: 160, height: 240, borderRadius: 8 },
  title: { fontFamily: fonts.serifBold, fontSize: 24, textAlign: 'center', lineHeight: 30 },
  authors: { fontFamily: fonts.sans, fontSize: 15, marginTop: 6, textAlign: 'center' },
  metaRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 8 },
  metaText: { fontFamily: fonts.sans, fontSize: 13 },
  description: { fontFamily: fonts.sans, fontSize: 14, lineHeight: 22, paddingHorizontal: 16, marginBottom: 16 },
  actions: { paddingHorizontal: 16, marginBottom: 24, gap: 10 },
  readButton: {
    paddingVertical: 14,
    borderRadius: 10,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
  },
  readButtonText: { color: '#fff', fontFamily: fonts.sansMedium, fontSize: 16 },
  secondaryButton: {
    paddingVertical: 12,
    borderRadius: 10,
    alignItems: 'center',
    borderWidth: 1.5,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 6,
  },
  secondaryButtonText: { fontFamily: fonts.sansMedium, fontSize: 14 },
  sectionTitle: { fontFamily: fonts.serifBold, fontSize: 20, paddingHorizontal: 16, marginBottom: 8 },
  chapterItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  chapterNumber: { width: 32, fontFamily: fonts.sansMedium, fontSize: 14 },
  chapterTitle: { flex: 1, fontFamily: fonts.sans, fontSize: 15 },
  errorWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    paddingVertical: 48,
    gap: 6,
  },
  errorTitle: { fontFamily: fonts.serifBold, fontSize: 20, marginTop: 16, textAlign: 'center' },
  errorBody: { fontFamily: fonts.sans, fontSize: 14, textAlign: 'center', marginTop: 4, maxWidth: 320 },
})
