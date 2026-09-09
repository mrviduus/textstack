import { useEffect, useState, useCallback, useMemo, useRef } from 'react'
import { View, Text, SectionList, StyleSheet, TouchableOpacity, TextInput, ActivityIndicator } from 'react-native'
import { useRouter, Stack } from 'expo-router'
import { Image } from 'expo-image'
import { Ionicons } from '@expo/vector-icons'
import { highlightsApi, getStorageUrl, isOfflineError } from '@textstack/shared'
import type { HighlightListItem } from '@textstack/shared'
import { useTheme } from '../../src/context/ThemeContext'
import { useLanguage } from '../../src/context/LanguageContext'
import { fonts } from '../../src/theme/typography'
import { useReconnectCount } from '../../src/hooks/useOnline'
import { EmptyState } from '../../src/components/ui/EmptyState'
import { HighlightQuote } from '../../src/components/HighlightQuote'

const PAGE_SIZE = 50
const HIGHLIGHT_COLORS: Record<string, string> = {
  yellow: '#FEF3C7',
  green: '#D1FAE5',
  pink: '#FCE7F3',
  blue: '#DBEAFE',
}

const COLOR_FILTERS = [
  { key: '', label: 'All' },
  { key: 'yellow', label: 'Yellow' },
  { key: 'green', label: 'Green' },
  { key: 'pink', label: 'Pink' },
  { key: 'blue', label: 'Blue' },
] as const

type BookType = 'all' | 'edition' | 'userbook'

const BOOK_TYPE_TABS: { key: BookType; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'edition', label: 'Library' },
  { key: 'userbook', label: 'Uploads' },
]

interface BookSection {
  title: string
  count: number
  coverPath: string | null
  data: HighlightListItem[]
}

export default function HighlightsScreen() {
  const router = useRouter()
  const { colors } = useTheme()
  const { t } = useLanguage()
  const [highlights, setHighlights] = useState<HighlightListItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<'offline' | 'failed' | null>(null)
  const [attempt, setAttempt] = useState(0)
  const reconnects = useReconnectCount()
  const [sort, setSort] = useState<'newest' | 'oldest'>('newest')
  const [colorFilter, setColorFilter] = useState('')
  const [bookType, setBookType] = useState<BookType>('all')
  const [search, setSearch] = useState('')
  const [searchDebounced, setSearchDebounced] = useState('')
  const [collapsedBooks, setCollapsedBooks] = useState<Set<string>>(new Set())

  // Generation counter prevents stale filter/sort responses from
  // overwriting fresh ones when the user toggles chips quickly.
  // loadingMoreRef guards onEndReached against concurrent re-entrance
  // (same pattern as vocabulary list — B-54).
  const genRef = useRef(0)
  const loadingMoreRef = useRef(false)

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search), 300)
    return () => clearTimeout(t)
  }, [search])

  const fetchHighlights = useCallback(async (offset = 0) => {
    if (offset > 0 && loadingMoreRef.current) return
    if (offset > 0) loadingMoreRef.current = true
    const gen = ++genRef.current
    try {
      const res = await highlightsApi.getAllHighlights({
        sort,
        limit: PAGE_SIZE,
        offset,
        color: colorFilter || undefined,
        search: searchDebounced || undefined,
        bookType: bookType === 'all' ? undefined : bookType,
      })
      if (gen !== genRef.current) return
      if (offset === 0) {
        setHighlights(res.items)
      } else {
        setHighlights(prev => [...prev, ...res.items])
      }
      setTotal(res.totalCount)
      if (gen === genRef.current) setLoadError(null)
    } catch (e) {
      if (gen === genRef.current) {
        console.warn('Failed to load highlights:', e)
        // Was console-only, so a failed load rendered "Your highlights will
        // appear here" — the new-reader screen, to someone whose highlights just
        // did not arrive.
        setLoadError(isOfflineError(e) ? 'offline' : 'failed')
      }
    } finally {
      if (offset > 0) loadingMoreRef.current = false
      if (gen === genRef.current) setLoading(false)
    }
  }, [sort, colorFilter, searchDebounced, bookType])

  // reconnects + attempt: recover when the network returns, and when asked.
  useEffect(() => { setLoading(true); fetchHighlights() }, [fetchHighlights, reconnects, attempt])

  // Group by book
  const sections = useMemo<BookSection[]>(() => {
    const groups = new Map<string, { title: string; coverPath: string | null; items: HighlightListItem[] }>()
    for (const h of highlights) {
      const bookKey = h.editionId || h.userBookId || '_none'
      const bookTitle = h.editionTitle || h.userBookTitle || 'Unknown Book'
      const coverPath = h.editionCoverPath || h.userBookCoverPath || null
      if (!groups.has(bookKey)) groups.set(bookKey, { title: bookTitle, coverPath, items: [] })
      groups.get(bookKey)!.items.push(h)
    }
    return Array.from(groups.values()).map(g => ({
      title: g.title,
      count: g.items.length,
      coverPath: g.coverPath,
      data: collapsedBooks.has(g.title) ? [] : g.items,
    }))
  }, [highlights, collapsedBooks])

  const toggleCollapse = (title: string) => {
    setCollapsedBooks(prev => {
      const next = new Set(prev)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })
  }

  const renderHighlight = ({ item }: { item: HighlightListItem }) => {
    const bgColor = HIGHLIGHT_COLORS[item.color] || HIGHLIGHT_COLORS.yellow
    const chapterTitle = item.chapterTitle || item.userChapterTitle || ''

    const handlePress = () => {
      if (item.editionId && item.editionSlug && item.chapterSlug) {
        router.push(`/reader/${item.editionSlug}/${item.chapterSlug}?highlight=${item.id}`)
      } else if (item.userBookId && item.userChapterSlug) {
        router.push(`/my-books/read/${item.userBookId}/${item.userChapterSlug}?highlight=${item.id}`)
      }
    }

    const isNavigable = !!(
      (item.editionId && item.editionSlug && item.chapterSlug) ||
      (item.userBookId && item.userChapterSlug)
    )

    return (
      <TouchableOpacity
        style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}
        onPress={handlePress}
        disabled={!isNavigable}
        activeOpacity={0.7}
      >
        <View style={[styles.colorStrip, { backgroundColor: bgColor }]} />
        <View style={styles.cardContent}>
          <HighlightQuote
            anchorJson={item.anchorJson}
            selectedText={item.selectedText}
            numberOfLines={4}
          />
          {item.noteText && (
            <View style={styles.noteRow}>
              <Ionicons name="create-outline" size={14} color={colors.textSecondary} />
              <Text style={[styles.noteText, { color: colors.textSecondary }]} numberOfLines={2}>
                {item.noteText}
              </Text>
            </View>
          )}
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8 }}>
            {chapterTitle ? (
              <Text style={[styles.metaText, { color: colors.textSecondary }]} numberOfLines={1}>{chapterTitle}</Text>
            ) : <View style={{ flex: 1 }} />}
            <View style={styles.badgeRow}>
              <Text style={[styles.dateText, { color: colors.textSecondary }]}>
                {new Date(item.createdAt).toLocaleDateString()}
              </Text>
            </View>
          </View>
        </View>
      </TouchableOpacity>
    )
  }

  const renderSectionHeader = ({ section }: { section: BookSection }) => {
    const isCollapsed = collapsedBooks.has(section.title)
    return (
      <TouchableOpacity
        style={[styles.sectionHeader, { backgroundColor: colors.background, borderBottomColor: colors.border }]}
        onPress={() => toggleCollapse(section.title)}
        activeOpacity={0.7}
      >
        <Ionicons name={isCollapsed ? 'chevron-forward' : 'chevron-down'} size={16} color={colors.textSecondary} />
        {section.coverPath && (
          <Image source={getStorageUrl(section.coverPath)} style={styles.sectionCover} contentFit="cover" />
        )}
        <Text style={[styles.sectionTitle, { color: colors.text }]} numberOfLines={1}>{section.title}</Text>
        <Text style={[styles.sectionCount, { color: colors.textSecondary }]}>{section.count}</Text>
      </TouchableOpacity>
    )
  }

  return (
    <>
      <Stack.Screen options={{
        title: 'Highlights',
        headerShown: true,
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.text,
        headerTitleStyle: { fontFamily: fonts.sansMedium, fontSize: 16 },
        headerShadowVisible: false,
        headerRight: () => (
          <TouchableOpacity
            onPress={() => router.push('/highlights/review')}
            style={{ marginRight: 8 }}
            accessibilityRole="button"
            // A lightning bolt promised a drill. The screen behind it turns pages.
            accessibilityLabel="Revisit highlights one at a time"
          >
            <Ionicons name="albums-outline" size={22} color={colors.primary} />
          </TouchableOpacity>
        ),
      }} />
      <View style={{ backgroundColor: colors.background, flex: 1 }}>
        {/* Search */}
        <View style={styles.searchRow}>
          <TextInput
            style={[styles.searchInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontFamily: fonts.sans }]}
            placeholder="Search highlights..."
            placeholderTextColor={colors.textSecondary}
            value={search}
            onChangeText={setSearch}
            autoCapitalize="none"
            autoCorrect={false}
          />
        </View>

        {/* Book type tabs */}
        <View style={styles.typeTabs}>
          {BOOK_TYPE_TABS.map(t => (
            <TouchableOpacity
              key={t.key}
              onPress={() => setBookType(t.key)}
              style={[styles.typeTab, bookType === t.key && { backgroundColor: colors.primary }]}
            >
              <Text style={{ fontFamily: fonts.sansMedium, fontSize: 12, color: bookType === t.key ? '#fff' : colors.textSecondary }}>
                {t.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* Filters: sort + color */}
        <View style={styles.filterRow}>
          {(['newest', 'oldest'] as const).map(s => (
            <TouchableOpacity
              key={s}
              onPress={() => setSort(s)}
              style={[styles.sortChip, sort === s && { backgroundColor: colors.primaryLight }]}
              activeOpacity={0.7}
            >
              <Text style={[styles.sortText, { color: sort === s ? colors.primary : colors.textSecondary }]}>
                {s === 'newest' ? 'Newest' : 'Oldest'}
              </Text>
            </TouchableOpacity>
          ))}
          <View style={{ width: 1, height: 16, backgroundColor: colors.border, marginHorizontal: 2 }} />
          {COLOR_FILTERS.map(c => (
            <TouchableOpacity
              key={c.key}
              onPress={() => setColorFilter(c.key)}
              style={[styles.colorChip, colorFilter === c.key && { backgroundColor: colors.primaryLight }]}
              activeOpacity={0.7}
            >
              {c.key ? (
                <View style={[styles.colorDot, { backgroundColor: HIGHLIGHT_COLORS[c.key] }]} />
              ) : (
                <Text style={[styles.sortText, { color: colorFilter === '' ? colors.primary : colors.textSecondary }]}>All</Text>
              )}
            </TouchableOpacity>
          ))}
          <Text style={[styles.totalLabel, { color: colors.textSecondary }]}>{total}</Text>
        </View>

        {loading ? (
          <ActivityIndicator style={{ padding: 40 }} color={colors.primary} />
        ) : highlights.length === 0 && loadError ? (
          <EmptyState
            icon={loadError === 'offline' ? 'cloud-offline-outline' : 'alert-circle-outline'}
            title={loadError === 'offline' ? t('library.offline.title') : t('library.loadFailed.title')}
            subtitle={loadError === 'offline' ? t('library.offline.body') : t('library.loadFailed.body')}
            buttonLabel={t('common.retry')}
            onButtonPress={() => { setLoading(true); setAttempt(a => a + 1) }}
          />
        ) : highlights.length === 0 ? (
          <EmptyState icon="color-wand-outline" title={t('highlights.emptyTitle')} subtitle={t('highlights.emptySubtitle')} />
        ) : (
          <SectionList
            sections={sections}
            renderItem={renderHighlight}
            renderSectionHeader={renderSectionHeader}
            keyExtractor={item => item.id}
            contentContainerStyle={styles.list}
            onEndReached={() => {
              if (loadingMoreRef.current) return
              if (highlights.length < total) fetchHighlights(highlights.length)
            }}
            onEndReachedThreshold={0.5}
            stickySectionHeadersEnabled={false}
          />
        )}
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  searchRow: { paddingHorizontal: 16, paddingTop: 12 },
  searchInput: { height: 38, borderRadius: 8, borderWidth: 1, paddingHorizontal: 12, fontSize: 14 },
  typeTabs: { flexDirection: 'row', gap: 6, paddingHorizontal: 16, paddingTop: 10 },
  typeTab: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16 },
  filterRow: { flexDirection: 'row', gap: 5, paddingHorizontal: 16, paddingVertical: 8, alignItems: 'center', flexWrap: 'wrap' },
  sortChip: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: 12 },
  sortText: { fontFamily: fonts.sansMedium, fontSize: 11 },
  colorChip: { paddingHorizontal: 6, paddingVertical: 4, borderRadius: 12 },
  colorDot: { width: 12, height: 12, borderRadius: 6 },
  totalLabel: { fontFamily: fonts.sans, fontSize: 11, marginLeft: 'auto' },
  list: { paddingBottom: 40 },
  sectionHeader: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  sectionCover: { width: 24, height: 36, borderRadius: 3 },
  sectionTitle: { fontFamily: fonts.sansMedium, fontSize: 14, flex: 1 },
  sectionCount: { fontFamily: fonts.sans, fontSize: 12 },
  card: { flexDirection: 'row', borderRadius: 12, borderWidth: 1, overflow: 'hidden', marginBottom: 10, marginHorizontal: 16 },
  colorStrip: { width: 4 },
  cardContent: { flex: 1, padding: 12 },
  selectedText: { fontFamily: fonts.serif, fontSize: 14, lineHeight: 20, fontStyle: 'italic' },
  noteRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 6, marginTop: 6 },
  noteText: { fontFamily: fonts.sans, fontSize: 12, lineHeight: 16, flex: 1 },
  metaText: { fontFamily: fonts.sans, fontSize: 11, flex: 1 },
  dateText: { fontFamily: fonts.sans, fontSize: 10 },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 2 },
  badgeText: { fontFamily: fonts.sansMedium, fontSize: 10 },
  emptyText: { fontFamily: fonts.sans, fontSize: 14, textAlign: 'center', paddingVertical: 40, paddingHorizontal: 32 },
})
