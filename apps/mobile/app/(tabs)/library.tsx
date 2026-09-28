import { useEffect, useState, useCallback, useRef } from 'react'
import { View, Text, TouchableOpacity } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import {
  libraryApi, readingProgressApi, userBooksApi, isOfflineError, plural,
} from '@textstack/shared'
import {
  collectionsApi, buildLibraryEntries, filterEntries, countEntries, sortEntries, entryTitle, entryAuthor,
  type UserLibraryItem, type UserBookDto, type ReadingProgressDto,
} from '@textstack/shared'
import { useAuth } from '../../src/context/AuthContext'
import { useTheme } from '../../src/context/ThemeContext'
import { useLanguage } from '../../src/context/LanguageContext'
import { useToast } from '../../src/context/ToastContext'
import { useCollectionsVersion } from '../../src/hooks/useCollections'
import { SkeletonLoader } from '../../src/components/ui/SkeletonLoader'
import { EmptyState } from '../../src/components/ui/EmptyState'
import { OfflineBanner } from '../../src/components/ui/OfflineBanner'
import { getAllCachedBooks, getAllCachedUserBooks } from '../../src/lib/offlineDb'
import { getAllUserBookLocalProgress, type UserBookProgressWithPercent } from '../../src/lib/progressStorage'
import { FirstBookState } from '../../src/components/library/FirstBookState'
import { LibraryViewSheet, type LibrarySource } from '../../src/components/library/LibraryViewSheet'
import { useSheetMount } from '../../src/hooks/useSheetMount'
import { LibrarySearch } from '../../src/components/library/LibrarySearch'
import { StorageQuotaRow } from '../../src/components/library/StorageQuotaRow'
import { LibraryStatusTabs } from '../../src/components/library/LibraryStatusTabs'
import { useLibrarySort } from '../../src/hooks/useLibrarySort'
import { useLibraryStatus } from '../../src/hooks/useLibraryStatus'
import { useLibrarySearch } from '../../src/hooks/useLibrarySearch'
import { matchesQuery } from '../../src/lib/searchUtils'
import { ResumeHero } from '../../src/components/library/ResumeHero'
import { useContinueReadingList } from '../../src/hooks/useContinueReadingList'
import { BookList } from '../../src/components/library/BookList'
import { styles, type ViewMode } from '../../src/components/library/shared'
import { fonts } from '../../src/theme/typography'

const VIEW_MODE_KEY = 'textstack_library_view'

// Module-level so the identity is stable — a fresh [] each render would
// invalidate useContinueReadingList's memo on every keystroke.
const EMPTY_LIBRARY: UserLibraryItem[] = []
const EMPTY_UPLOADS: UserBookDto[] = []

export default function LibraryScreen() {
  const { isAuthenticated } = useAuth()
  const { colors } = useTheme()
  const { t } = useLanguage()
  const { show: showToast } = useToast()
  const router = useRouter()
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [source, setSource] = useState<LibrarySource>('all')
  const [sheetOpen, setSheetOpen] = useState(false)
  // The sheet's `useCollections` fired `GET /me/library/collections` on every
  // tab open just by being in the tree. See useSheetMount.
  const sheetMounted = useSheetMount(sheetOpen)
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(null)
  const [collectionSavedIds, setCollectionSavedIds] = useState<Set<string> | null>(null)
  const [collectionUploadIds, setCollectionUploadIds] = useState<Set<string> | null>(null)
  const collectionsVersion = useCollectionsVersion()
  // One library means one of each control. These used to be duplicated per tab
  // — two sort keys, two status filters, two search boxes — because there were
  // two lists.
  const { sort, setSort } = useLibrarySort('library')
  const { status, setStatus } = useLibraryStatus()
  const { query, debouncedQuery, setQuery, clear: clearQuery } = useLibrarySearch('library')
  const [library, setLibrary] = useState<UserLibraryItem[]>([])
  const [userBooks, setUserBooks] = useState<UserBookDto[]>([])
  const [progressMap, setProgressMap] = useState<Record<string, ReadingProgressDto>>({})
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  // Why the list is empty, when it is. Without this the screen cannot tell
  // "you have no books" from "I could not ask", and it showed the first-run
  // welcome to an offline reader with twelve books — indistinguishable from
  // having lost the account.
  const [loadError, setLoadError] = useState<'offline' | 'failed' | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Generation counter guards against:
  //  1. Out-of-order resolution — pull-to-refresh racing a focus-effect
  //     reload; the slower response would otherwise overwrite fresher data.
  //  2. Set-state-after-unmount — tab swap during an in-flight request.
  // Set to -1 on unmount so trailing resolutions are dropped (B-10).
  // Must sit above the early returns below — it is a hook, and `loading` /
  // `!isAuthenticated` both bail out before the render body.
  // The resume card is a lens over the same books, so it obeys the same source
  // filter. It used to be computed from the unfiltered data and rendered ABOVE
  // the filter row, so switching to "My uploads" left a catalog book sitting on
  // top of a list that had just excluded it — the screen contradicting itself.
  const resumeList = useContinueReadingList(
    source === 'uploads' ? EMPTY_LIBRARY : library,
    progressMap,
    source === 'catalog' ? EMPTY_UPLOADS : userBooks,
  )

  const loadGenRef = useRef(0)
  useEffect(() => () => { loadGenRef.current = -1 }, [])

  const loadData = useCallback(async () => {
    if (!isAuthenticated) { setLoading(false); return }
    const myGen = ++loadGenRef.current
    try {
      const [lib, progress, books] = await Promise.all([
        libraryApi.getLibrary(),
        readingProgressApi.getAllProgress(),
        userBooksApi.getUserBooks(),
      ])
      if (myGen !== loadGenRef.current) return // superseded or unmounted
      setLibrary(lib)
      setUserBooks(books)
      setLoadError(null)
      const map: Record<string, ReadingProgressDto> = {}
      for (const p of progress) map[p.editionId] = p
      setProgressMap(map)
    } catch (e) {
      if (myGen !== loadGenRef.current) return
      console.error('Library load error:', e)
      const offline = isOfflineError(e)
      setLoadError(offline ? 'offline' : 'failed')
      // Offline: fall back to what is genuinely on the device. A downloaded book
      // — catalog or upload — carries its title and cover in SQLite, the same
      // rehydration app/book/[slug].tsx has always done. Books that were saved
      // but never downloaded are not on the device at all, so the banner still
      // says the list is partial rather than pretending it is whole.
      if (offline) {
        try {
          // Both libraries, from the device. Uploads could not be cached at all
          // until they became downloadable, so an offline reader's own books —
          // the ones this product is mostly about — were the half missing here.
          const [cached, cachedUploads, localProgress] = await Promise.all([
            getAllCachedBooks(),
            getAllCachedUserBooks(),
            getAllUserBookLocalProgress().catch(() => new Map<string, UserBookProgressWithPercent>()),
          ])
          if (myGen !== loadGenRef.current) return
          setUserBooks(prev => (prev.length > 0 ? prev : cachedUploads.map(c => ({
            id: c.bookId,
            title: c.title,
            author: c.author,
            language: c.language ?? 'en',
            coverPath: c.coverPath,
            genre: null,
            totalWordCount: c.totalWordCount,
            // A cached copy only ever exists for a book that finished processing.
            status: 'Ready',
            chapterCount: c.totalChapters,
            createdAt: new Date(c.cachedAt).toISOString(),
            completedAt: null,
            errorMessage: null,
            progressPercent: localProgress.get(c.bookId)?.bookPercent ?? null,
            progressUpdatedAt: localProgress.get(c.bookId)
              ? new Date(localProgress.get(c.bookId)!.updatedAt).toISOString()
              : null,
            progressChapterSlug: localProgress.get(c.bookId)?.chapterSlug ?? null,
            // False whatever the upload was: offline it reads as text (ADR-012).
            hasOriginalPdf: false,
          }))))
          setLibrary(prev => (prev.length > 0 ? prev : cached.map(c => ({
            editionId: c.editionId,
            slug: c.slug,
            title: c.title,
            // Not known offline: CachedBookMeta does not store it, and nothing on
            // this screen reads it. Fabricated to satisfy the type, and wrong the
            // day a second catalogue language ships — at which point the cache
            // table needs the column rather than this line needing a better guess.
            language: 'en',
            coverPath: c.coverPath,
            createdAt: new Date(c.cachedAt).toISOString(),
            author: null,
          }))))
        } catch { /* cache unavailable — the banner still explains the empty list */ }
      }
    } finally {
      if (myGen === loadGenRef.current) setLoading(false)
    }
  }, [isAuthenticated])


  // Auto-refresh while processing books exist
  useEffect(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
    const hasProcessing = userBooks.some(b => b.status.toLowerCase() === 'processing')
    if (!hasProcessing) return
    pollRef.current = setInterval(async () => {
      try {
        const books = await userBooksApi.getUserBooks()
        setUserBooks(books)
      } catch (e) {
        // Don't toast here — polling errors should stay quiet, otherwise a
        // flaky connection would spam the user once every 5s. Just log.
        console.warn('Library user-books poll failed:', e)
      }
    }, 5000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [userBooks])

  // Persist view mode
  useEffect(() => {
    AsyncStorage.getItem(VIEW_MODE_KEY).then(v => { if (v === 'grid' || v === 'list') setViewMode(v) }).catch(() => {})
  }, [])
  const toggleView = (mode: ViewMode) => { setViewMode(mode); AsyncStorage.setItem(VIEW_MODE_KEY, mode).catch(() => {}) }

  useEffect(() => { loadData() }, [loadData])

  useFocusEffect(useCallback(() => {
    if (isAuthenticated && !loading) loadData()
  }, [isAuthenticated, loading, loadData]))

  useEffect(() => {
    if (!activeCollectionId) {
      setCollectionSavedIds(null)
      setCollectionUploadIds(null)
      return
    }
    let cancelled = false
    Promise.all([
      collectionsApi.getCollectionBookIds(activeCollectionId, 'savedbook').catch(() => [] as string[]),
      collectionsApi.getCollectionBookIds(activeCollectionId, 'userbook').catch(() => [] as string[]),
    ]).then(([s, u]) => {
      if (cancelled) return
      setCollectionSavedIds(new Set(s))
      setCollectionUploadIds(new Set(u))
    })
    return () => { cancelled = true }
    // collectionsVersion bumps when caches invalidate (e.g. after add-to-
    // collection) — refetch keeps the active filter in sync without the user
    // having to leave & re-enter the collection.
  }, [activeCollectionId, collectionsVersion])

  const onRefresh = async () => {
    setRefreshing(true)
    await loadData()
    setRefreshing(false)
  }

  if (!isAuthenticated) {
    // Two honest answers for an empty shelf, and until 2026-09-28 only the
    // second was offered. A reader with no session was sent to Sign In — the
    // one thing that was never required to add a book, since a guest may
    // upload (ADR-014 §3a) and the upload route mints the session itself. The
    // account is for carrying a library between phones, which is a real reason
    // and a secondary one.
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <EmptyState
          icon="library-outline"
          title={t('library.title')}
          subtitle="Add a book and start reading. An account is only needed to carry your library to another phone."
          buttonLabel="Upload a book"
          onButtonPress={() => router.push('/my-books/upload')}
          secondaryLabel="Sign in"
          onSecondaryPress={() => router.push('/(auth)/login')}
        />
      </View>
    )
  }

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <View style={styles.skeletonList}>
          {[0, 1, 2, 3].map(i => (
            <View key={i} style={[styles.bookRow, { borderBottomColor: colors.border }]}>
              <SkeletonLoader width={70} height={105} borderRadius={6} />
              <View style={styles.bookInfo}>
                <SkeletonLoader width="70%" height={16} />
                <SkeletonLoader width="40%" height={13} style={{ marginTop: 6 }} />
                <SkeletonLoader width="90%" height={4} style={{ marginTop: 12 }} />
              </View>
            </View>
          ))}
        </View>
      </View>
    )
  }

  // Nothing to show AND a reason for it — never the welcome screen. `loadError`
  // is what separates "no books" from "no answer"; conflating them was the bug.
  if (library.length === 0 && userBooks.length === 0 && loadError) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <EmptyState
          icon={loadError === 'offline' ? 'cloud-offline-outline' : 'alert-circle-outline'}
          title={loadError === 'offline' ? t('library.offline.title') : t('library.loadFailed.title')}
          subtitle={loadError === 'offline' ? t('library.offline.body') : t('library.loadFailed.body')}
          buttonLabel={t('common.retry')}
          onButtonPress={() => { setLoading(true); loadData() }}
        />
      </View>
    )
  }

  // Nothing anywhere: one screen, one action. Rendering the lists here would
  // give the user a search box, status tabs, a sort row and a grid toggle for
  // zero books — and a generic "browse the catalog" CTA, which is the wrong
  // first step for a reader who came here to read their own file.
  if (library.length === 0 && userBooks.length === 0) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <FirstBookState />
      </View>
    )
  }

  // One list. Source, status, search and sort are lenses over the same books —
  // never separate destinations. `buildLibraryEntries` tags each record with the
  // storage shape it came from so a row can show what only that shape has (an
  // upload can be mid-parse) without splitting the list in two.
  const sourceEntries = buildLibraryEntries(library, userBooks, source)
  const counts = countEntries(sourceEntries, progressMap)
  const statusFiltered = filterEntries(sourceEntries, status, progressMap)
  const searched = debouncedQuery
    ? statusFiltered.filter(e => matchesQuery({ title: entryTitle(e), author: entryAuthor(e) }, debouncedQuery))
    : statusFiltered
  const collectionFiltered = activeCollectionId
    ? searched.filter(e => (e.kind === 'saved' ? collectionSavedIds : collectionUploadIds)?.has(
        e.kind === 'saved' ? e.item.editionId : e.book.id,
      ) ?? false)
    : searched
  const entries = sortEntries(collectionFiltered, sort, progressMap)

  // Everything above the first book row. Three blocks: resume, search, filters.
  // It used to be thirteen — roughly 2.4 screens of chrome a reader scrolled
  // past to reach their own books.
  // What "a filter is on" means, in one place. It was implicit before, and the
  // Clear button only knew about two of the four things that can hide a book.
  const sourceFiltered = source !== 'all' || activeCollectionId != null
  const anyFilterActive = sourceFiltered || status !== 'all' || !!debouncedQuery
  const clearAllFilters = () => {
    setSource('all')
    setActiveCollectionId(null)
    setStatus('all')
    clearQuery()
  }

  const listHeader = (
    <>
      {/* Above everything, because it changes how the whole list should be read:
          uploads and saved-but-undownloaded books are not cached at all. */}
      {loadError === 'offline' && <OfflineBanner message={t('library.offline.partial')} />}
      {resumeList.length > 0 && <ResumeHero pick={resumeList[0]} />}
      {/* Silent until the store is nearly full, so it appears exactly when it
          changes what the reader would do next. The full figure is on Profile. */}
      <StorageQuotaRow variant="warning" refreshKey={userBooks.length} />
      <LibrarySearch value={query} onChange={setQuery} onClear={clearQuery} />
      <View style={styles.controlRow}>
        <View style={{ flex: 1 }}>
          <LibraryStatusTabs value={status} onChange={setStatus} counts={counts} />
        </View>
        <TouchableOpacity
          onPress={() => setSheetOpen(true)}
          hitSlop={10}
          style={styles.viewBtn}
          accessibilityRole="button"
          accessibilityLabel={sourceFiltered ? t('library.view.openFiltered') : t('library.view.open')}
        >
          <Ionicons
            name="options-outline"
            size={20}
            color={sourceFiltered ? colors.primary : colors.text}
          />
          {/* The only place the active source was ever shown was inside the
              sheet — which is closed. Ten books vanishing with no visible cause
              reads as data loss, not as a filter. */}
          {sourceFiltered && (
            <View style={[styles.filterDot, { backgroundColor: colors.primary, borderColor: colors.background }]} />
          )}
        </TouchableOpacity>
      </View>
      {/* The count the tabs used to carry, in the one place with room for it.
          On the tabs it was four chips competing for a phone's width and losing;
          here it is a sentence, and it says what you are looking at rather than
          what you are not. */}
      {entries.length > 0 && (
        <Text style={[styles.resultCount, { color: colors.textSecondary }]}>
          {plural(entries.length, 'book', 'books')}
        </Text>
      )}
      {entries.length === 0 && (
        <View style={styles.filterEmpty}>
          <Text style={{ fontFamily: fonts.sans, fontSize: 14, color: colors.textSecondary, textAlign: 'center' }}>
            {debouncedQuery ? t('library.search.empty').replace('{query}', debouncedQuery) : t('library.filter.empty')}
          </Text>
          {/* Was setStatus('all') and nothing else. With source = "My uploads"
              and no uploads, the button that says "Clear filter" visibly did
              nothing at all — a dead end whose only exit was reopening the
              sheet the reader could not tell was involved. */}
          <TouchableOpacity
            onPress={clearAllFilters}
            style={[styles.filterEmptyBtn, { borderColor: colors.border }]}
            accessibilityRole="button"
          >
            <Text style={{ fontFamily: fonts.sansMedium, fontSize: 13, color: colors.text }}>
              {debouncedQuery && !sourceFiltered && status === 'all'
                ? t('library.search.clear')
                : t('library.filter.clear')}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </>
  )

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      <BookList
        entries={entries}
        progressMap={progressMap}
        library={library}
        setLibrary={setLibrary}
        setProgressMap={setProgressMap}
        refreshing={refreshing}
        onRefresh={onRefresh}
        viewMode={viewMode}
        listHeader={listHeader}
      />
      {sheetMounted && <LibraryViewSheet
        visible={sheetOpen}
        source={source}
        counts={{ all: library.length + userBooks.length, uploads: userBooks.length, catalog: library.length }}
        sort={sort}
        viewMode={viewMode}
        activeCollectionId={activeCollectionId}
        onSelectSource={setSource}
        onSelectSort={setSort}
        onSelectViewMode={toggleView}
        onCollectionSelect={setActiveCollectionId}
        onClose={() => setSheetOpen(false)}
      />}
    </View>
  )
}
