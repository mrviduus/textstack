import { useState, useCallback, useEffect, useRef } from 'react'
import { View, Text, TextInput, FlatList, ScrollView, StyleSheet, TouchableOpacity } from 'react-native'
import { Image } from 'expo-image'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { createBooksApi, getStorageUrl, isOfflineError, plural } from '@textstack/shared'
import type { SearchResult, Edition, Author } from '@textstack/shared'
import { useTheme } from '../../src/context/ThemeContext'
import { useLanguage } from '../../src/context/LanguageContext'
import { fonts } from '../../src/theme/typography'
import { SkeletonLoader, BookGridSkeleton } from '../../src/components/ui/SkeletonLoader'
import { OfflineBanner } from '../../src/components/ui/OfflineBanner'
import { useReconnectCount } from '../../src/hooks/useOnline'
import { BookCard } from '../../src/components/ui/BookCard'
import { EmptyState } from '../../src/components/ui/EmptyState'
import { StartReadingCard } from '../../src/components/discover/StartReadingCard'
import { trackSearchPerformed } from '../../src/lib/analytics'

/** Renders HTML search highlights with <b> tags as bold Text spans */
function HighlightText({ html, style, boldStyle, numberOfLines }: {
  html: string; style: any; boldStyle?: any; numberOfLines?: number
}) {
  const parts = html.split(/(<b>.*?<\/b>)/g)
  return (
    <Text style={style} numberOfLines={numberOfLines}>
      {parts.map((part, i) => {
        if (part.startsWith('<b>') && part.endsWith('</b>')) {
          const text = part.slice(3, -4)
          return <Text key={i} style={[{ fontWeight: '700' }, boldStyle]}>{text}</Text>
        }
        return part.replace(/<[^>]+>/g, '')
      })}
    </Text>
  )
}

const RECENT_KEY = 'textstack_recent_searches'
const MAX_RECENT = 8
const RESULTS_PER_PAGE = 10
const BOOK_LIMIT = 12
const AUTHOR_LIMIT = 8

interface EditionGroup {
  editionId: string
  slug: string
  title: string
  coverPath: string | null
  bestMatch: SearchResult
  otherMatches: SearchResult[]
}

function groupByEdition(results: SearchResult[]): EditionGroup[] {
  const map = new Map<string, SearchResult[]>()
  for (const r of results) {
    const key = r.edition.id
    if (!map.has(key)) map.set(key, [])
    map.get(key)!.push(r)
  }
  return Array.from(map.entries()).map(([id, items]) => ({
    editionId: id,
    slug: items[0].edition.slug,
    title: items[0].edition.title,
    coverPath: items[0].edition.coverPath,
    bestMatch: items[0],
    otherMatches: items.slice(1),
  }))
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

export default function DiscoverScreen() {
  const router = useRouter()
  const { colors } = useTheme()
  const { language, t } = useLanguage()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [searched, setSearched] = useState(false)
  const [recentSearches, setRecentSearches] = useState<string[]>([])
  const [page, setPage] = useState(1)
  const [expandedEditions, setExpandedEditions] = useState<Set<string>>(new Set())
  const inputRef = useRef<TextInput>(null)
  // Generation counter so a slow response for an abandoned query can't
  // clobber results from the latest one (B-15). The shared API doesn't
  // accept AbortController yet, so this is the next-best guard — it
  // discards stale payloads cheaply without touching the package layer.
  const searchGenRef = useRef(0)
  useEffect(() => () => { searchGenRef.current = -1 }, [])

  // Catalog data
  const [books, setBooks] = useState<Edition[]>([])
  const [authors, setAuthors] = useState<Author[]>([])
  const [catalogStats, setCatalogStats] = useState<{ books: number; authors: number; genres: number } | null>(null)
  const [catalogLoading, setCatalogLoading] = useState(true)
  // The catalog, "Recently Added" and the author row are each gated on their own
  // data being non-empty, so a failed fetch made all three vanish and left a
  // search box and an "Ask the librarian" card with no explanation. Empty and
  // unreachable are different states and now look different.
  const [catalogError, setCatalogError] = useState<'offline' | 'failed' | null>(null)
  const [searchOffline, setSearchOffline] = useState(false)
  const reconnects = useReconnectCount()
  // Bumped by the banner's retry, so a reader who does not want to wait for
  // NetInfo can ask again.
  const [catalogAttempt, setCatalogAttempt] = useState(0)

  const debouncedQuery = useDebounce(query.trim(), 300)

  // Load recent searches
  useEffect(() => {
    let cancelled = false
    AsyncStorage.getItem(RECENT_KEY).then(v => {
      if (cancelled || !v) return
      try { setRecentSearches(JSON.parse(v)) } catch {}
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  // Fetch catalog data. Cancellation guards against a language flip
  // landing the previous language's catalog on screen.
  useEffect(() => {
    let cancelled = false
    const api = createBooksApi(language)
    Promise.all([
      api.getBooks({ limit: BOOK_LIMIT }),
      api.getAuthors({ limit: AUTHOR_LIMIT, sort: 'recent' }),
      api.getGenres(),
    ]).then(([booksRes, authorsRes, genresRes]) => {
      if (cancelled) return
      setBooks(booksRes.items)
      setAuthors(authorsRes.items)
      setCatalogStats({ books: booksRes.total, authors: authorsRes.total, genres: genresRes.total })
      setCatalogError(null)
    }).catch(e => {
      if (cancelled) return
      console.error('Catalog fetch failed:', e)
      // Was `setCatalogOffline(isOfflineError(e))`, so a 500 set it to FALSE and
      // Discover rendered blank with no message at all — three sections gated on
      // their own data, all empty, nothing to explain it.
      setCatalogError(isOfflineError(e) ? 'offline' : 'failed')
    })
      .finally(() => { if (!cancelled) setCatalogLoading(false) })
    return () => { cancelled = true }
    // `reconnects` is the fix for N-2. This was `[language]` alone, and Discover
    // is a tab screen that never unmounts — so once the catalog failed, nothing
    // re-ran it. The banner survived the network coming back and could only be
    // cleared by restarting the app.
  }, [language, reconnects, catalogAttempt])

  // Use functional setState so saveRecent/removeRecent don't need
  // `recentSearches` in their deps — that previously leaked into doSearch's
  // deps, which made doSearch churn on every save (P2-5) and risked stale
  // closures for `language` (P1-1).
  const saveRecent = useCallback(async (q: string) => {
    let nextList: string[] = []
    setRecentSearches(prev => {
      nextList = [q, ...prev.filter(s => s !== q)].slice(0, MAX_RECENT)
      return nextList
    })
    await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(nextList)).catch(() => {})
  }, [])

  const removeRecent = useCallback(async (q: string) => {
    let nextList: string[] = []
    setRecentSearches(prev => {
      nextList = prev.filter(s => s !== q)
      return nextList
    })
    await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(nextList)).catch(() => {})
  }, [])

  const clearRecent = useCallback(async () => {
    setRecentSearches([])
    await AsyncStorage.removeItem(RECENT_KEY).catch(() => {})
  }, [])

  const doSearch = useCallback(async (q: string) => {
    if (q.length < 2) return
    const gen = ++searchGenRef.current
    setLoading(true)
    setSearched(true)
    setPage(1)
    setExpandedEditions(new Set())
    try {
      const api = createBooksApi(language)
      const { items } = await api.search(q, { limit: 100, highlight: true })
      // Bail if the user typed something else while this fetch was in
      // flight. Without this, a slow response for "har" would overwrite
      // the results for "harry" that arrived first.
      if (gen !== searchGenRef.current) return
      setSearchOffline(false)
      setResults(items)
      saveRecent(q)
      trackSearchPerformed({ query: q, resultsCount: items.length })
    } catch (e) {
      if (gen !== searchGenRef.current) return
      console.error('Search failed:', e)
      // A search that never reached the server rendered as "No results for
      // harry" — which reads as a claim about the catalog, not about the
      // connection, and sends the reader off to doubt their spelling.
      setSearchOffline(isOfflineError(e))
    } finally {
      if (gen === searchGenRef.current) setLoading(false)
    }
  }, [language, saveRecent])

  // Auto-search on debounced query change. `doSearch` is now stable against
  // recentSearches churn (see comment above), so including it is cheap and
  // guarantees a fresh closure over `language` when the user switches
  // native language mid-session (P1-1).
  useEffect(() => {
    if (debouncedQuery.length >= 2) doSearch(debouncedQuery)
    else if (debouncedQuery.length === 0 && searched) {
      setResults([])
      setSearched(false)
    }
  }, [debouncedQuery, doSearch, searched])

  const grouped = groupByEdition(results)
  const totalPages = Math.ceil(grouped.length / RESULTS_PER_PAGE)
  const paged = grouped.slice(0, page * RESULTS_PER_PAGE)
  const hasMore = page < totalPages

  const toggleExpand = (editionId: string) => {
    setExpandedEditions(prev => {
      const next = new Set(prev)
      if (next.has(editionId)) next.delete(editionId)
      else next.add(editionId)
      return next
    })
  }

  const renderGroup = ({ item }: { item: EditionGroup }) => {
    const isExpanded = expandedEditions.has(item.editionId)
    const highlights = (item.bestMatch.highlights || []).slice(0, 2)

    return (
      <TouchableOpacity
        style={[styles.resultCard, { backgroundColor: colors.surface }]}
        onPress={() => router.push(`/book/${item.slug}`)}
        activeOpacity={0.85}
      >
        <Image
          source={item.coverPath ? getStorageUrl(item.coverPath) : undefined}
          style={[styles.cover, { backgroundColor: colors.border }]}
          contentFit="cover"
        />
        <View style={styles.info}>
          <Text style={[styles.title, { color: colors.text }]} numberOfLines={1}>{item.title}</Text>
          <Text style={[styles.chapter, { color: colors.textSecondary }]} numberOfLines={1}>
            Ch. {item.bestMatch.chapterNumber}: {item.bestMatch.chapterTitle}
          </Text>
          {highlights.map((h, i) => (
            <HighlightText key={i} html={h} style={[styles.highlight, { color: colors.textSecondary }]} boldStyle={{ color: colors.text }} numberOfLines={2} />
          ))}

          {item.otherMatches.length > 0 && (
            <TouchableOpacity
              style={styles.moreBtn}
              onPress={() => toggleExpand(item.editionId)}
              hitSlop={8}
            >
              <Text style={{ fontFamily: fonts.sans, fontSize: 12, color: colors.primary }}>
                {isExpanded ? t('search.hideChapters') : `+${item.otherMatches.length} more match${item.otherMatches.length > 1 ? 'es' : ''}`}
              </Text>
              <Ionicons name={isExpanded ? 'chevron-up' : 'chevron-down'} size={14} color={colors.primary} />
            </TouchableOpacity>
          )}

          {isExpanded && item.otherMatches.map((m, i) => (
            <View key={i} style={[styles.subMatch, { borderTopColor: colors.border }]}>
              <Text style={[styles.chapter, { color: colors.textSecondary }]} numberOfLines={1}>
                Ch. {m.chapterNumber}: {m.chapterTitle}
              </Text>
              {(m.highlights || []).slice(0, 2).map((h, hi) => (
                <HighlightText key={hi} html={h} style={[styles.highlight, { color: colors.textSecondary }]} boldStyle={{ color: colors.text }} numberOfLines={2} />
              ))}
            </View>
          ))}
        </View>
      </TouchableOpacity>
    )
  }

  const showRecent = !searched && !loading && query.length === 0 && recentSearches.length > 0
  const showCatalog = !searched && !loading

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Above the search box on purpose: searching assumes you already know
          what you are looking for, and this screen is the first thing an
          install shows. The card hides itself once anything has been read
          (see StartReadingCard / decideStartReadingCard), after which this
          screen is exactly what it is today. */}
      {!searched && <StartReadingCard />}

      <View style={styles.searchBar}>
        <View style={[styles.inputWrapper, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Ionicons name="search-outline" size={18} color={colors.textSecondary} />
          <TextInput
            ref={inputRef}
            style={[styles.input, { color: colors.text }]}
            value={query}
            onChangeText={setQuery}
            placeholder={t('search.searchPlaceholder')}
            placeholderTextColor={colors.textSecondary}
            returnKeyType="search"
            onSubmitEditing={() => doSearch(query.trim())}
            autoCorrect={false}
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => { setQuery(''); setResults([]); setSearched(false) }}>
              <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* Ask the librarian — natural-language, reasoned recommendations (signed-in only; the screen gates). */}
      {!searched && (
        <TouchableOpacity
          style={[styles.librarianEntry, { backgroundColor: colors.surface, borderColor: colors.border }]}
          onPress={() => router.push('/librarian')}
          activeOpacity={0.85}
          accessibilityRole="button"
          accessibilityLabel={t('librarian.title')}
        >
          <View style={[styles.librarianIcon, { backgroundColor: colors.primaryLight }]}>
            <Ionicons name="sparkles-outline" size={18} color={colors.primary} />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.librarianTitle, { color: colors.text, fontFamily: fonts.sansMedium }]}>
              {t('librarian.title')}
            </Text>
            <Text style={[styles.librarianSubtitle, { color: colors.textSecondary, fontFamily: fonts.sans }]} numberOfLines={1}>
              {t('librarian.entry.hint')}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
        </TouchableOpacity>
      )}

      {loading ? (
        <View style={styles.skeletonList}>
          {[0, 1, 2, 3].map(i => (
            <View key={i} style={[styles.resultCard, { backgroundColor: colors.surface }]}>
              <SkeletonLoader width={50} height={70} borderRadius={4} />
              <View style={styles.info}>
                <SkeletonLoader width="70%" height={14} />
                <SkeletonLoader width="50%" height={12} style={{ marginTop: 6 }} />
                <SkeletonLoader width="90%" height={12} style={{ marginTop: 6 }} />
              </View>
            </View>
          ))}
        </View>
      ) : results.length === 0 && searched ? (
        searchOffline ? (
          <EmptyState
            icon="cloud-offline-outline"
            title={t('search.offline.title')}
            subtitle={t('search.offline.body')}
            buttonLabel={t('common.retry')}
            onButtonPress={() => doSearch(query)}
          />
        ) : (
          <EmptyState
            icon="search-outline"
            title={`${t('search.noResults')} "${query}"`}
          />
        )
      ) : searched ? (
        <FlatList
          data={paged}
          renderItem={renderGroup}
          keyExtractor={item => item.editionId}
          contentContainerStyle={styles.list}
          onEndReached={() => { if (hasMore) setPage(p => p + 1) }}
          onEndReachedThreshold={0.5}
          ListHeaderComponent={
            <Text style={[styles.resultCount, { color: colors.textSecondary }]}>
              {grouped.length} {grouped.length === 1 ? 'book' : 'books'} · {results.length} {results.length === 1 ? 'match' : 'matches'}
            </Text>
          }
        />
      ) : (
        <ScrollView contentContainerStyle={{ paddingBottom: 40 }}>
          {/* Recent Searches */}
          {showRecent && (
            <View style={styles.recentSection}>
              <View style={styles.recentHeader}>
                <Text style={[styles.recentTitle, { color: colors.text }]}>{t('search.recentSearches')}</Text>
                <TouchableOpacity onPress={clearRecent}>
                  <Text style={{ fontFamily: fonts.sans, fontSize: 13, color: colors.primary }}>{t('search.clearAll')}</Text>
                </TouchableOpacity>
              </View>
              {recentSearches.map((q, i) => (
                <TouchableOpacity
                  key={i}
                  style={[styles.recentRow, { borderBottomColor: colors.border }]}
                  onPress={() => { setQuery(q); doSearch(q) }}
                >
                  <Ionicons name="time-outline" size={16} color={colors.textSecondary} />
                  <Text style={[styles.recentText, { color: colors.text }]}>{q}</Text>
                  <TouchableOpacity onPress={() => removeRecent(q)} hitSlop={8}>
                    <Ionicons name="close" size={16} color={colors.textSecondary} />
                  </TouchableOpacity>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {/* One sentence instead of three silently missing sections. Discover is
              the only place with nothing cached to fall back on, so it says so
              rather than rendering a convincing-looking empty page. */}
          {catalogError && !catalogLoading && (
            <OfflineBanner
              message={catalogError === 'offline' ? t('search.offline.catalog') : t('library.loadFailed.body')}
              actionLabel={t('common.retry')}
              onAction={() => setCatalogAttempt(a => a + 1)}
            />
          )}

          {/* Catalog Stats Bar */}
          {catalogStats && (
            /* Three links that read as a caption. They are the same shade as
               body text with no chevron and no underline, while "View all books →"
               sits a few rows below styled correctly — the contrast is inside one
               screen. Tinting them and adding the chevron says they go somewhere. */
            <View style={[styles.statsBar, { borderColor: colors.border }]}>
              {([
                { label: plural(catalogStats.books, 'book', 'books'), to: '/books' as const },
                { label: plural(catalogStats.authors, 'author', 'authors'), to: '/authors' as const },
                { label: plural(catalogStats.genres, 'genre', 'genres'), to: '/genres' as const },
              ]).map((item, i) => (
                <View key={item.to} style={styles.statGroup}>
                  {i > 0 && <Text style={[styles.statDot, { color: colors.border }]}>&middot;</Text>}
                  <TouchableOpacity
                    onPress={() => router.push(item.to)}
                    style={styles.statLink}
                    accessibilityRole="link"
                    accessibilityLabel={item.label}
                  >
                    <Text style={[styles.statItem, { color: colors.primary }]}>{item.label}</Text>
                    <Ionicons name="chevron-forward" size={12} color={colors.primary} />
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {/* Recent Books */}
          {catalogLoading ? (
            <BookGridSkeleton count={6} />
          ) : books.length > 0 ? (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('home.recentBooks.title')}</Text>
                <TouchableOpacity onPress={() => router.push('/books')} activeOpacity={0.7}>
                  <View style={styles.viewAllRow}>
                    <Text style={[styles.viewAllText, { color: colors.primary }]}>{t('home.recentBooks.viewAll')}</Text>
                    <Ionicons name="arrow-forward" size={16} color={colors.primary} />
                  </View>
                </TouchableOpacity>
              </View>
              <View style={styles.booksGrid}>
                {books.map((book, index) => (
                  <BookCard
                    key={book.id}
                    title={book.title}
                    author={book.authors.map(a => a.name).join(', ')}
                    coverUrl={getStorageUrl(book.coverPath)}
                    onPress={() => router.push(`/book/${book.slug}`)}
                    animationDelay={index * 80}
                  />
                ))}
              </View>
            </View>
          ) : null}

          {/* Authors */}
          {authors.length > 0 && (
            <View style={styles.section}>
              <View style={styles.sectionHeader}>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>{t('home.recentAuthors.title')}</Text>
                <TouchableOpacity onPress={() => router.push('/authors')} activeOpacity={0.7}>
                  <View style={styles.viewAllRow}>
                    <Text style={[styles.viewAllText, { color: colors.primary }]}>{t('home.recentAuthors.viewAll')}</Text>
                    <Ionicons name="arrow-forward" size={16} color={colors.primary} />
                  </View>
                </TouchableOpacity>
              </View>
              <FlatList
                data={authors}
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.authorsScroll}
                keyExtractor={item => item.id}
                scrollEnabled
                renderItem={({ item }) => (
                  <TouchableOpacity
                    style={styles.authorCard}
                    onPress={() => router.push(`/author/${item.slug}`)}
                    activeOpacity={0.7}
                  >
                    {item.photoPath ? (
                      <Image source={getStorageUrl(item.photoPath)} style={styles.authorPhoto} contentFit="cover" />
                    ) : (
                      <View style={[styles.authorPhoto, styles.authorPlaceholder, { backgroundColor: colors.primaryLight }]}>
                        <Text style={[styles.authorInitial, { color: colors.primary }]}>
                          {item.name?.[0] || '?'}
                        </Text>
                      </View>
                    )}
                    <Text style={[styles.authorName, { color: colors.text }]} numberOfLines={2}>
                      {item.name}
                    </Text>
                  </TouchableOpacity>
                )}
              />
            </View>
          )}
        </ScrollView>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 12 },
  searchBar: { padding: 12 },
  librarianEntry: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 12,
    marginBottom: 8,
    padding: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  librarianIcon: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  librarianTitle: { fontSize: 15 },
  librarianSubtitle: { fontSize: 12, marginTop: 2 },
  inputWrapper: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderWidth: 1,
    gap: 8,
  },
  input: {
    flex: 1,
    fontFamily: fonts.sans,
    fontSize: 15,
    padding: 0,
  },
  list: { paddingHorizontal: 12, paddingBottom: 20 },
  skeletonList: { paddingHorizontal: 12 },
  resultCard: {
    flexDirection: 'row',
    padding: 12,
    marginBottom: 8,
    borderRadius: 10,
  },
  cover: { width: 50, height: 70, borderRadius: 4 },
  info: { flex: 1, marginLeft: 12, justifyContent: 'center' },
  title: { fontFamily: fonts.sansMedium, fontSize: 15 },
  chapter: { fontFamily: fonts.sans, fontSize: 13, marginTop: 2 },
  highlight: { fontFamily: fonts.sans, fontSize: 12, marginTop: 4, fontStyle: 'italic' },
  emptyText: { fontFamily: fonts.sans, fontSize: 15, textAlign: 'center' },
  resultCount: { fontFamily: fonts.sans, fontSize: 12, marginBottom: 8 },
  moreBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  subMatch: { paddingTop: 8, marginTop: 8, borderTopWidth: 1 },

  // Recent searches
  recentSection: { paddingHorizontal: 16, marginBottom: 16 },
  recentHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  recentTitle: { fontFamily: fonts.sansMedium, fontSize: 16 },
  recentRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  recentText: { fontFamily: fonts.sans, fontSize: 14, flex: 1 },

  // Catalog stats bar
  statsBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: 12,
    gap: 8,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    marginHorizontal: 16,
    marginBottom: 8,
  },
  statItem: { fontFamily: fonts.sansMedium, fontSize: 13 },
  statGroup: { flexDirection: 'row', alignItems: 'center' },
  statLink: { flexDirection: 'row', alignItems: 'center', gap: 1 },
  statDot: { fontSize: 16 },

  // Sections
  section: { marginTop: 16 },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 16,
    marginBottom: 12,
  },
  sectionTitle: { fontFamily: fonts.serifBold, fontSize: 20 },
  viewAllRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  viewAllText: { fontFamily: fonts.sansMedium, fontSize: 14 },

  // Books grid
  booksGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 16,
    justifyContent: 'space-between',
  },

  // Authors horizontal scroll
  authorsScroll: { paddingHorizontal: 16, gap: 14 },
  authorCard: { alignItems: 'center', width: 80 },
  authorPhoto: { width: 64, height: 64, borderRadius: 32, marginBottom: 6 },
  authorPlaceholder: { justifyContent: 'center', alignItems: 'center' },
  authorInitial: { fontFamily: fonts.serif, fontSize: 24 },
  authorName: { fontFamily: fonts.sans, fontSize: 12, textAlign: 'center' },
})
