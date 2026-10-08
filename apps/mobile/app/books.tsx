import { useEffect, useState, useCallback, useRef } from 'react'
import { View, Text, FlatList, StyleSheet, TouchableOpacity, TextInput } from 'react-native'
import { useRouter } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import { createBooksApi, getStorageUrl, isOfflineError } from '@textstack/shared'
import type { Edition, Genre } from '@textstack/shared'
import { useTheme } from '../src/context/ThemeContext'
import { useLanguage } from '../src/context/LanguageContext'
import { fonts } from '../src/theme/typography'
import { useReconnectCount } from '../src/hooks/useOnline'
import { BookCard } from '../src/components/ui/BookCard'
import { FilterChips } from '../src/components/ui/FilterChips'

const PAGE_SIZE = 20
const SORT_OPTIONS = [
  { key: 'popular', label: 'Popular' },
  { key: 'recent', label: 'Recent' },
  { key: 'title', label: 'Title' },
  { key: 'oldest', label: 'Oldest' },
] as const

export default function BooksScreen() {
  const router = useRouter()
  const { colors } = useTheme()
  const { language } = useLanguage()

  const [books, setBooks] = useState<Edition[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<'offline' | 'failed' | null>(null)
  const [attempt, setAttempt] = useState(0)
  const reconnects = useReconnectCount()
  const [loadingMore, setLoadingMore] = useState(false)
  const [query, setQuery] = useState('')
  const [queryDebounced, setQueryDebounced] = useState('')
  const [sort, setSort] = useState('popular')
  // '' = all genres. 'popular' is a SORT; as a genre it matched nothing and the list was always empty.
  const [genre, setGenre] = useState('')
  const [genres, setGenres] = useState<Genre[]>([])
  const lastFetchRef = useRef(0)
  const genresGenRef = useRef(0)

  // Debounce search input — 300ms mirrors highlights + search screens.
  // Without it every keystroke fired a request, burning bandwidth and
  // creating bursts of stale responses the generation counter has to
  // throw away.
  useEffect(() => {
    const h = setTimeout(() => setQueryDebounced(query), 300)
    return () => clearTimeout(h)
  }, [query])

  useEffect(() => {
    const gen = ++genresGenRef.current
    createBooksApi(language).getGenres()
      .then(res => {
        if (gen !== genresGenRef.current) return
        setGenres(res.items)
      })
      .catch(e => {
        if (gen === genresGenRef.current) console.warn('Failed to load genres:', e)
      })
  }, [language])

  const fetchBooks = useCallback(async (reset = true) => {
    const api = createBooksApi(language)
    const offset = reset ? 0 : books.length
    if (reset) setLoading(true)
    else setLoadingMore(true)
    const id = ++lastFetchRef.current
    try {
      const res = await api.getBooks({
        limit: PAGE_SIZE,
        offset,
        search: queryDebounced || undefined,
        genre: genre || undefined,
        sort,
      })
      if (id !== lastFetchRef.current) return
      setLoadError(null)
      setBooks(prev => reset ? res.items : [...prev, ...res.items])
      setTotal(res.total)
    } catch (e) {
      if (id === lastFetchRef.current) {
        console.warn('Failed to fetch books:', e)
        // "No books found" is a statement about the catalog. A failed request is
        // a statement about the request, and they are not the same sentence.
        setLoadError(isOfflineError(e) ? 'offline' : 'failed')
      }
    } finally {
      if (id === lastFetchRef.current) {
        setLoading(false)
        setLoadingMore(false)
      }
    }
  }, [queryDebounced, sort, genre, books.length, language])

  // reconnects + attempt: recover when the network returns, and on request.
  useEffect(() => { fetchBooks(true) }, [queryDebounced, sort, genre, language, reconnects, attempt])

  const loadMore = () => {
    if (!loadingMore && books.length < total) fetchBooks(false)
  }

  const hasFilters = !!(query || genre || sort !== 'popular')

  return (
    <View style={[styles.container, { backgroundColor: colors.bgWarm }]}>
      {/* Header */}
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
          <Ionicons name="arrow-back" size={24} color={colors.text} />
        </TouchableOpacity>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Books</Text>
        <View style={{ width: 24 }} />
      </View>

      {/* Search + Sort */}
      <View style={styles.controls}>
        <View style={[styles.searchBar, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <Ionicons name="search-outline" size={18} color={colors.textSecondary} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder="Search books..."
            placeholderTextColor={colors.textSecondary}
            value={query}
            onChangeText={setQuery}
          />
          {query.length > 0 && (
            <TouchableOpacity onPress={() => setQuery('')}>
              <Ionicons name="close-circle" size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
        </View>
        <View style={styles.sortRow}>
          {SORT_OPTIONS.map(s => (
            <TouchableOpacity
              key={s.key}
              onPress={() => setSort(s.key)}
              style={[styles.sortChip, { backgroundColor: sort === s.key ? colors.primary + '18' : colors.surface, borderColor: sort === s.key ? colors.primary : colors.border }]}
            >
              <Text style={[styles.sortChipText, { color: sort === s.key ? colors.primary : colors.textSecondary }]}>{s.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </View>

      {/* Genre chips */}
      {genres.length > 0 && (
        <FilterChips
          options={[{ key: '', label: 'All' }, ...genres.map(g => ({ key: g.slug, label: g.name }))]}
          selected={genre}
          onSelect={(key) => setGenre(genre === key ? '' : key)}
        />
      )}

      {/* Books grid */}
      <FlatList
        data={books}
        numColumns={2}
        keyExtractor={item => item.id}
        contentContainerStyle={styles.grid}
        columnWrapperStyle={styles.gridRow}
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        ListEmptyComponent={
          loading ? null : loadError ? (
            // This file writes its copy inline rather than through t(); following
            // that convention here rather than converting the screen inside a
            // defect fix.
            <View style={styles.emptyBox}>
              <Text style={[styles.empty, { color: colors.textSecondary }]}>
                {loadError === 'offline'
                  ? "You're offline — the catalog needs a connection."
                  : "Couldn't load the catalog."}
              </Text>
              <TouchableOpacity onPress={() => { setLoading(true); setAttempt(a => a + 1) }}>
                <Text style={[styles.clearBtn, { color: colors.primary }]}>Try again</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <View style={styles.emptyBox}>
              <Text style={[styles.empty, { color: colors.textSecondary }]}>
                {hasFilters ? 'No books found' : 'No books yet'}
              </Text>
              {hasFilters && (
                <TouchableOpacity onPress={() => { setQuery(''); setGenre(''); setSort('popular') }}>
                  <Text style={[styles.clearBtn, { color: colors.primary }]}>Clear filters</Text>
                </TouchableOpacity>
              )}
            </View>
          )
        }
        ListFooterComponent={
          loadingMore ? (
            <Text style={[styles.loadingMore, { color: colors.textSecondary }]}>Loading...</Text>
          ) : null
        }
        renderItem={({ item }) => (
          <BookCard
            title={item.title}
            author={item.authors.map(a => a.name).join(', ')}
            coverUrl={getStorageUrl(item.coverPath)}
            onPress={() => router.push(`/book/${item.slug}`)}
          />
        )}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 54,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  backBtn: { padding: 4 },
  headerTitle: { fontFamily: fonts.serifBold, fontSize: 20 },
  controls: { paddingHorizontal: 16, paddingTop: 12 },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: 1,
    gap: 8,
  },
  searchInput: { flex: 1, fontFamily: fonts.sans, fontSize: 15, padding: 0 },
  sortRow: { flexDirection: 'row', gap: 8, marginTop: 10 },
  sortChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  sortChipText: { fontFamily: fonts.sansMedium, fontSize: 13 },
  grid: { padding: 16 },
  gridRow: { justifyContent: 'space-between' },
  emptyBox: { alignItems: 'center', marginTop: 40, gap: 12 },
  empty: { fontFamily: fonts.sans, fontSize: 15, textAlign: 'center' },
  clearBtn: { fontFamily: fonts.sansMedium, fontSize: 14 },
  loadingMore: { fontFamily: fonts.sans, fontSize: 13, textAlign: 'center', padding: 16 },
})
