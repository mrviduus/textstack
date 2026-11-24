import { useEffect, useState, useCallback, useRef } from 'react'
import { View, Text, TouchableOpacity } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useRouter, useFocusEffect } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { isOfflineError, plural } from '@textstack/shared'
import { userBooksApi } from '../../src/lib/userBooksApi'
import { syncEpoch } from '../../src/lib/sync'
import { logLoadError } from '../../src/lib/logLoadError'
import {
  buildLibraryEntries, filterEntries, countEntries, sortEntries, entryTitle, entryAuthor, OPENED_AT_KEY, parseOpenedAt,
  type UserLibraryItem, type UserBookDto, type ReadingProgressDto,
} from '@textstack/shared'
import { useAuth } from '../../src/context/AuthContext'
import { useTheme } from '../../src/context/ThemeContext'
import { useLanguage } from '../../src/context/LanguageContext'
import { SkeletonLoader } from '../../src/components/ui/SkeletonLoader'
import { EmptyState } from '../../src/components/ui/EmptyState'
import { OfflineBanner } from '../../src/components/ui/OfflineBanner'
import { deviceLocalLibrary } from '../../src/lib/reader/deviceLibrary'
import { getAllUserBookLocalProgress, type UserBookProgressWithPercent } from '../../src/lib/progressStorage'
import { FirstBookState } from '../../src/components/library/FirstBookState'
import { LibraryViewSheet } from '../../src/components/library/LibraryViewSheet'
import { useSheetMount } from '../../src/hooks/useSheetMount'
import { LibrarySearch } from '../../src/components/library/LibrarySearch'
import { LibraryStatusTabs } from '../../src/components/library/LibraryStatusTabs'
import { useLibrarySort } from '../../src/hooks/useLibrarySort'
import { useLibraryStatus } from '../../src/hooks/useLibraryStatus'
import { useLibrarySearch } from '../../src/hooks/useLibrarySearch'
import { matchesQuery } from '@textstack/shared'
import { useContinueReadingList } from '../../src/hooks/useContinueReadingList'
import { BookList } from '../../src/components/library/BookList'
import { styles, type ViewMode } from '../../src/components/library/shared'
import { fonts } from '../../src/theme/typography'

const VIEW_MODE_KEY = 'textstack_library_view'

// The catalog shelf and its progress: none since the catalog retired (M6). Module-level so the identity is
// stable — a fresh [] each render would invalidate useContinueReadingList's memo on every keystroke.
const NO_CATALOG: UserLibraryItem[] = []
const NO_CATALOG_PROGRESS: Record<string, ReadingProgressDto> = {}

export default function LibraryScreen() {
  const { isAuthenticated } = useAuth()
  const { colors } = useTheme()
  const { t } = useLanguage()
  const router = useRouter()
  const [viewMode, setViewMode] = useState<ViewMode>('list')
  const [sheetOpen, setSheetOpen] = useState(false)
  const sheetMounted = useSheetMount(sheetOpen)
  // One library means one of each control. These used to be duplicated per tab
  // — two sort keys, two status filters, two search boxes — because there were
  // two lists.
  const { sort, setSort } = useLibrarySort('library')
  const { status, setStatus } = useLibraryStatus()
  const { query, debouncedQuery, setQuery, clear: clearQuery } = useLibrarySearch('library')
  const [userBooks, setUserBooks] = useState<UserBookDto[]>([])
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
  const resumeList = useContinueReadingList(NO_CATALOG, NO_CATALOG_PROGRESS, userBooks)

  const loadGenRef = useRef(0)
  useEffect(() => () => { loadGenRef.current = -1 }, [])

  const loadData = useCallback(async () => {
    // Bumped before the session check: a sign-out supersedes a load still in flight (#1191).
    const myGen = ++loadGenRef.current
    if (!isAuthenticated) { setLoading(false); return }
    const epoch = syncEpoch()
    try {
      const books = await userBooksApi.getUserBooks()
      if (myGen !== loadGenRef.current) return // superseded or unmounted
      setUserBooks(books)
      setLoadError(null)
    } catch (e) {
      if (myGen !== loadGenRef.current) return
      // The V2 store was reset mid-load (account switch, guest → account): the list is the new
      // account's to fetch, not a failure to show (#1191).
      if (syncEpoch() !== epoch) return void loadData()
      logLoadError('Library load error:', e)
      const offline = isOfflineError(e)
      setLoadError(offline ? 'offline' : 'failed')
      // Offline: fall back to what is genuinely on the device — the books whose file is here (the V2
      // local library); books never downloaded are not on the device at all, so the banner still says
      // the list is partial rather than pretending it is whole.
      if (offline) {
        try {
          const [onDevice, localProgress] = await Promise.all([
            deviceLocalLibrary().books().then(bs => bs.filter(b => b.local)),
            getAllUserBookLocalProgress().catch(() => new Map<string, UserBookProgressWithPercent>()),
          ])
          if (myGen !== loadGenRef.current) return
          setUserBooks(prev => (prev.length > 0 ? prev : onDevice.map(c => ({
            id: c.id,
            title: c.title,
            author: c.author || null,
            language: 'en',
            coverPath: null,
            genre: null,
            totalWordCount: null,
            // Its file is here: readable.
            status: 'Ready',
            chapterCount: 0,
            createdAt: new Date(c.importedAt).toISOString(),
            completedAt: null,
            errorMessage: null,
            progressPercent: localProgress.get(c.id)?.bookPercent ?? null,
            progressUpdatedAt: localProgress.get(c.id)
              ? new Date(localProgress.get(c.id)!.updatedAt).toISOString()
              : null,
            progressChapterSlug: localProgress.get(c.id)?.chapterSlug ?? null,
            hasOriginalPdf: false,
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

  // Focus owns the load — first open included. A separate mount effect plus a
  // `loading` dep here loaded twice per open: the flag flipping false re-created
  // this callback while focused, which re-ran it (6 requests instead of 3).
  useFocusEffect(useCallback(() => { loadData() }, [loadData]))
  /** This device's opens of uploads (the V2 reader marks them): "Recently opened" without a server write. Read on focus. */
  const [openedAt, setOpenedAt] = useState<Record<string, number>>({})
  useFocusEffect(useCallback(() => { AsyncStorage.getItem(OPENED_AT_KEY).then((j) => setOpenedAt(parseOpenedAt(j))).catch(() => {}) }, []))

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
  if (userBooks.length === 0 && loadError) {
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
  if (userBooks.length === 0) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background }]}>
        <FirstBookState />
      </View>
    )
  }

  // One list. Status, search and sort are lenses over the same books — never separate destinations.
  const sourceEntries = buildLibraryEntries(NO_CATALOG, userBooks, 'uploads')
  const counts = countEntries(sourceEntries, NO_CATALOG_PROGRESS)
  const statusFiltered = filterEntries(sourceEntries, status, NO_CATALOG_PROGRESS)
  const searched = debouncedQuery
    ? statusFiltered.filter(e => matchesQuery({ title: entryTitle(e), author: entryAuthor(e) }, debouncedQuery))
    : statusFiltered
  const entries = sortEntries(searched, sort, NO_CATALOG_PROGRESS, openedAt)

  // Everything above the first book row. Two blocks: search, filters. Continue lives on the rows.
  // It used to be thirteen — roughly 2.4 screens of chrome a reader scrolled
  // past to reach their own books.
  const clearAllFilters = () => {
    setStatus('all')
    clearQuery()
  }

  const listHeader = (
    <>
      {/* Above everything, because it changes how the whole list should be read:
          uploads and saved-but-undownloaded books are not cached at all. */}
      {loadError === 'offline' && <OfflineBanner message={t('library.offline.partial')} />}
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
          accessibilityLabel={t('library.view.open')}
        >
          <Ionicons name="options-outline" size={20} color={colors.text} />
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
              {debouncedQuery && status === 'all'
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
        refreshing={refreshing}
        onRefresh={onRefresh}
        viewMode={viewMode}
        listHeader={listHeader}
        resumeList={resumeList}
      />
      {sheetMounted && <LibraryViewSheet
        visible={sheetOpen}
        sort={sort}
        viewMode={viewMode}
        onSelectSort={setSort}
        onSelectViewMode={toggleView}
        onClose={() => setSheetOpen(false)}
      />}
    </View>
  )
}
