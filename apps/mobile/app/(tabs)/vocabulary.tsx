import { useEffect, useState, useCallback, useRef } from 'react'
import {
  View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput,
  RefreshControl, ScrollView } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useRouter } from 'expo-router'
import { isOfflineError, plural } from '@textstack/shared'
import { vocabularyApi } from '../../src/lib/vocabularyApi'
import type { VocabularyWordDto } from '@textstack/shared'
import { useAuth } from '../../src/context/AuthContext'
import { useTheme } from '../../src/context/ThemeContext'
import { useLanguage } from '../../src/context/LanguageContext'
import { useToast } from '../../src/context/ToastContext'
import { fonts } from '../../src/theme/typography'
import { SkeletonLoader } from '../../src/components/ui/SkeletonLoader'
import { EmptyState } from '../../src/components/ui/EmptyState'
import { useTts } from '../../src/hooks/useTts'
import { useReconnectCount } from '../../src/hooks/useOnline'
import { useRefocusEffect } from '../../src/hooks/useRefocusEffect'
import { VocabViewSheet } from '../../src/components/vocabulary/VocabViewSheet'
import { VocabSummaryCard } from '../../src/components/vocabulary/VocabSummaryCard'
import { buildContextSnippet } from '@textstack/shared'
import { resolveListScreenState } from '../../src/lib/listScreenState'

const STAGE_LABELS = ['New', 'Recognition', 'Recall', 'Context', 'Mastered']
const STAGE_COLORS = ['#9CA3AF', '#3B82F6', '#F59E0B', '#8B5CF6', '#10B981']

const TABS = [
  { key: 'all', label: 'All', filter: undefined },
  { key: 'new', label: 'New', filter: '0' },
  { key: 'learning', label: 'Learning', filter: '1,2,3' },
  { key: 'mastered', label: 'Mastered', filter: '4' },
] as const

const SORT_OPTIONS = [
  { key: 'recent', label: 'Recent' },
  { key: 'alphabetical', label: 'A-Z' },
  { key: 'due', label: 'Due' },
  { key: 'stage', label: 'Stage' },
] as const

type TabKey = typeof TABS[number]['key']
type SortKey = typeof SORT_OPTIONS[number]['key']

export default function VocabularyScreen() {
  // `isLoading` is the stored-session read, and it is NOT the same as "signed out":
  // `isAuthenticated` is false for the whole of it. Passed through so the machine can
  // hold the skeleton instead of flashing the sign-in wall on a cold start.
  const { isAuthenticated, isLoading: isAuthLoading } = useAuth()
  // V2 (#1025): no tutor, cluster rounds, review-style switch, stats, settings, pending words or lookups;
  // review runs as flashcards.
  const { colors } = useTheme()
  const { t } = useLanguage()
  const router = useRouter()
  const { toggle: toggleTts } = useTts()
  const { show: showToast } = useToast()
  const [words, setWords] = useState<VocabularyWordDto[]>([])
  const [tab, setTab] = useState<TabKey>('all')
  const [sort, setSort] = useState<SortKey>('recent')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [total, setTotal] = useState(0)
  const [viewSheetOpen, setViewSheetOpen] = useState(false)
  // Why the list is empty, when it is.
  const [loadError, setLoadError] = useState<'offline' | 'failed' | null>(null)

  const activeFilter = TABS.find(t => t.key === tab)?.filter

  const offsetRef = useRef(0)
  // Tracks the newest loadData call. Prevents stale filter/search responses
  // from overwriting current results when the user types quickly or flips
  // tabs mid-flight (B-10). Set to -1 on unmount.
  const loadGenRef = useRef(0)
  // Blocks re-entrant loadData(true) from `onEndReached` — FlatList can fire
  // the callback multiple times while a fetch is in flight on short lists.
  const loadingMoreRef = useRef(false)
  useEffect(() => () => { loadGenRef.current = -1 }, [])

  const loadData = useCallback(async (loadMore = false) => {
    // Nothing here is public. Without this the screen fired /me/vocabulary/words
    // and /me/vocabulary/stats at a reader with no session, took two 401s, and —
    // since `isOfflineError` is false for a 401 — reported them as `failed`:
    // "Something went wrong on our side", plus a Retry button that 401s forever.
    // The reader does not have a broken app, they have no account.
    if (!isAuthenticated) { setLoading(false); return }
    if (loadMore && loadingMoreRef.current) return
    if (loadMore) loadingMoreRef.current = true
    const myGen = ++loadGenRef.current
    try {
      const currentOffset = loadMore ? offsetRef.current : 0
      const res = await vocabularyApi.getWords({ stage: activeFilter, search: search || undefined, sort, limit: 50, offset: currentOffset })
      if (myGen !== loadGenRef.current) return
      if (loadMore) {
        setWords(prev => [...prev, ...res.items])
      } else {
        setWords(res.items)
      }
      setTotal(res.total)
      setLoadError(null)
      offsetRef.current = currentOffset + res.items.length
    } catch (e) {
      if (myGen !== loadGenRef.current) return
      console.warn('Vocab load error:', e)
      // Tell the screen WHY the list is empty. Without this it rendered "No
      // words saved yet" to a reader who had one — the same defect Library was
      // treated for, on a screen the treatment never reached.
      setLoadError(isOfflineError(e) ? 'offline' : 'failed')
      throw e
    } finally {
      if (loadMore) loadingMoreRef.current = false
      if (myGen === loadGenRef.current) setLoading(false)
    }
  }, [isAuthenticated, activeFilter, search, sort])

  // `reconnects` in the deps is what makes the screen recover on its own. A tab
  // screen never unmounts, so without it the only way back from an offline load
  // was restarting the app.
  const reconnects = useReconnectCount()
  useEffect(() => {
    setLoading(true); offsetRef.current = 0
    loadData().catch(() => {})
  }, [loadData, reconnects])

  // RE-focus only: the effect above owns the first load and every filter /
  // search / sort change. A focus callback keyed on `loading` re-fired each
  // time `loading` flipped false — a second words + stats pair per change.
  useRefocusEffect(() => {
    if (!loading) { offsetRef.current = 0; loadData().catch(() => {}) }
  })

  const onRefresh = async () => {
    setRefreshing(true)
    offsetRef.current = 0
    await loadData()
    setRefreshing(false)
  }

  const handleDelete = async (id: string) => {
    // Optimistic remove + rollback on error. Prior impl silently swallowed
    // failures — the row stayed, user tapped again thinking nothing happened,
    // spamming the API. Snapshot → filter → rollback + toast if API rejects.
    const snapshot = words
    const snapshotTotal = total
    setWords(prev => prev.filter(w => w.id !== id))
    setTotal(prev => prev - 1)
    setExpandedId(null)
    try {
      await vocabularyApi.deleteWord(id)
    } catch (e) {
      console.warn('Delete vocab word failed:', e)
      setWords(snapshot)
      setTotal(snapshotTotal)
      showToast({ message: 'Could not delete word. Try again.', variant: 'error' })
    }
  }

  const handleEdit = async (id: string, data: { translation?: string; definition?: string }) => {
    try {
      const updated = await vocabularyApi.updateWord(id, data)
      setWords(prev => prev.map(w => w.id === id ? updated : w))
    } catch (e) {
      console.warn('Edit vocab word failed:', e)
      showToast({ message: 'Could not save changes. Try again.', variant: 'error' })
    }
  }

  const hasMore = words.length < total

  // One decision, in one place, with a test behind it. The precedence used to
  // live in the ternary chain below, where `loading` was checked first and no
  // session was not checked at all.
  const screenState = resolveListScreenState({
    isAuthLoading,
    isAuthenticated,
    loading,
    loadError,
    hasItems: words.length > 0,
  })

  if (screenState === 'signin') {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <EmptyState
          icon="book-outline"
          title={t('vocabulary.title')}
          subtitle={t('vocabulary.signInPrompt')}
          buttonLabel="Sign In"
          onButtonPress={() => router.push('/(auth)/login')}
        />
      </View>
    )
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      {/* Three blocks above the first word, not eight — the same treatment
          Library got. What stays is what changes the next action: one card with
          the due count and its button, search, and the filter. Everything that
          only shapes the view is behind the gear. */}
      {/* While the list has words, or a filter or search may be hiding them. */}
      {(total > 0 || !!activeFilter || !!search) && <VocabSummaryCard onPractice={() => router.push('/vocabulary/review')} />}

      <VocabViewSheet
        visible={viewSheetOpen}
        sort={sort}
        sortOptions={SORT_OPTIONS}
        onSelectSort={k => setSort(k as SortKey)}
        onClose={() => setViewSheetOpen(false)}
      />

      {/* Search sits above the filter, like Library's. */}
      <View style={styles.searchSortRow}>
        <TextInput
          style={[styles.searchInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontFamily: fonts.sans }]}
          placeholder="Search words..."
          placeholderTextColor={colors.textSecondary}
          value={search}
          onChangeText={setSearch}
          autoCapitalize="none"
          autoCorrect={false}
        />
      </View>

      {/* Filter tabs + the one entry to everything else */}
      <View style={styles.tabsRow}>
        <View style={{ flex: 1 }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
        {TABS.map(t => (
          <TouchableOpacity
            key={t.key}
            style={[styles.tab, { backgroundColor: colors.surface, borderColor: colors.border }, tab === t.key && { backgroundColor: colors.primary, borderColor: colors.primary }]}
            onPress={() => setTab(t.key)}
          >
            <Text style={[styles.tabText, { color: colors.textSecondary, fontFamily: fonts.sansMedium }, tab === t.key && { color: '#fff' }]}>
              {t.label}
            </Text>
          </TouchableOpacity>
        ))}
          </ScrollView>
        </View>
        <TouchableOpacity
          onPress={() => setViewSheetOpen(true)}
          hitSlop={10}
          style={styles.viewBtn}
          accessibilityRole="button"
          accessibilityLabel="View options"
        >
          <Ionicons name="options-outline" size={20} color={colors.text} />
        </TouchableOpacity>
      </View>

      {screenState === 'loading' ? (
        <View style={styles.listContent}>
          {Array.from({ length: 6 }).map((_, i) => (
            <View key={i} style={[styles.wordRow, { borderBottomColor: colors.border }]}>
              <View style={styles.wordHeader}>
                <View style={{ flex: 1 }}>
                  <SkeletonLoader width={100} height={16} />
                  <SkeletonLoader width={140} height={13} style={{ marginTop: 4 }} />
                </View>
                <SkeletonLoader width={60} height={20} borderRadius={4} />
              </View>
            </View>
          ))}
        </View>
      ) : screenState === 'offline' || screenState === 'failed' ? (
        // "You have no words" and "I could not ask" are different screens — and
        // both are different from "you have no account", which never reaches here.
        <EmptyState
          icon={screenState === 'offline' ? 'cloud-offline-outline' : 'alert-circle-outline'}
          title={screenState === 'offline' ? t('library.offline.title') : t('library.loadFailed.title')}
          subtitle={screenState === 'offline' ? t('vocabulary.offline.body') : t('library.loadFailed.body')}
          buttonLabel={t('common.retry')}
          onButtonPress={() => { setLoading(true); offsetRef.current = 0; loadData().catch(() => {}) }}
        />
      ) : screenState === 'empty' ? (
        <EmptyState
          icon="book-outline"
          title={t('vocabulary.empty')}
          buttonLabel={t('nav.library')}
          onButtonPress={() => router.push('/(tabs)/library')}
        />
      ) : (
        <FlatList
          data={words}
          keyExtractor={item => item.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          contentContainerStyle={styles.listContent}
          onEndReached={() => { if (hasMore && !loading) loadData(true) }}
          onEndReachedThreshold={0.5}
          ListFooterComponent={hasMore ? (
            <Text style={{ textAlign: 'center', padding: 12, fontSize: 12, color: colors.textSecondary, fontFamily: fonts.sans }}>
              {plural(total, 'word', 'words', `${words.length} of {n} {noun}`)}
            </Text>
          ) : null}
          renderItem={({ item }) => (
            <WordRow
              word={item}
              expanded={expandedId === item.id}
              onToggle={() => setExpandedId(expandedId === item.id ? null : item.id)}
              onDelete={() => handleDelete(item.id)}
              onEdit={(data) => handleEdit(item.id, data)}
              onSpeak={(text) => toggleTts(text, { lang: item.language })}
            />
          )}
        />
      )}
    </View>
  )
}


function ContextSnippet({ sentence, word }: { sentence: string; word: string }) {
  const { colors } = useTheme()
  const snippet = buildContextSnippet(sentence, word)
  // No snippet means the word is not in the stored text. Printing the paragraph
  // head anyway — which is what this did — shows a quote that does not contain
  // the word it belongs to. The caller shows the translation instead.
  if (!snippet) return null
  return (
    <Text style={[styles.contextText, { color: colors.textSecondary }]} numberOfLines={1}>
      {snippet.before}
      <Text style={{ fontFamily: fonts.sansBold, color: colors.text }}>{snippet.match}</Text>
      {snippet.after}
    </Text>
  )
}

function WordRow({
  word, expanded, onToggle, onDelete, onEdit, onSpeak,
}: {
  word: VocabularyWordDto
  expanded: boolean
  onToggle: () => void
  onDelete: () => void
  onEdit: (data: { translation?: string; definition?: string }) => void
  onSpeak: (text: string) => void
}) {
  const { colors } = useTheme()
  const [editField, setEditField] = useState<'translation' | 'definition' | null>(null)
  const [editValue, setEditValue] = useState('')
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const deleteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleDeletePress = () => {
    if (confirmingDelete) {
      if (deleteTimerRef.current) clearTimeout(deleteTimerRef.current)
      onDelete()
    } else {
      setConfirmingDelete(true)
      deleteTimerRef.current = setTimeout(() => setConfirmingDelete(false), 3000)
    }
  }

  const startEdit = (field: 'translation' | 'definition') => {
    setEditField(field)
    setEditValue(field === 'translation' ? (word.translation || '') : (word.definition || ''))
  }

  const handleSaveEdit = () => {
    if (!editField) return
    onEdit({ [editField]: editValue.trim() || undefined })
    setEditField(null)
  }
  const stageLabel = STAGE_LABELS[word.stage] || 'Unknown'
  const stageColor = STAGE_COLORS[word.stage] || '#9CA3AF'

  return (
    <TouchableOpacity style={[styles.wordRow, { borderBottomColor: colors.border }]} onPress={onToggle} activeOpacity={0.7}>
      <View style={styles.wordHeader}>
        <TouchableOpacity onPress={() => onSpeak(word.word)} hitSlop={8} style={{ padding: 2, marginRight: 6 }}>
          <Ionicons name="volume-medium-outline" size={16} color={colors.primary} />
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={[styles.wordText, { color: colors.text, fontFamily: fonts.sansMedium }]}>{word.word}</Text>
          {/* Both, not either. This was an either/or, so a word with a stored
              sentence never showed its translation in the collapsed row — the
              translation is the reason the word was saved, and it was the one
              thing missing. The quote comes second because it is context. */}
          {word.translation && !editField && (
            <Text style={[styles.wordTranslation, { color: colors.textSecondary, fontFamily: fonts.sans }]} numberOfLines={1}>{word.translation}</Text>
          )}
          {word.sentence && !expanded && (
            <ContextSnippet sentence={word.sentence} word={word.word} />
          )}
        </View>
        {!expanded && (
          <View style={[styles.stageBadge, { backgroundColor: stageColor + '20' }]}>
            <Text style={[styles.stageText, { color: stageColor, fontFamily: fonts.sansMedium }]}>{stageLabel}</Text>
          </View>
        )}
      </View>

      {expanded && (
        <View style={[styles.wordDetail, { borderTopColor: colors.border }]}>
          {/* Stage badge in expanded view */}
          <View style={[styles.stageBadge, { backgroundColor: stageColor + '20', alignSelf: 'flex-start', marginBottom: 8 }]}>
            <Text style={[styles.stageText, { color: stageColor, fontFamily: fonts.sansMedium }]}>{stageLabel}</Text>
          </View>
          {/* Edit translation / definition */}
          {editField ? (
            <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
              <TextInput
                style={[styles.editInput, { backgroundColor: colors.surface, borderColor: colors.border, color: colors.text, fontFamily: fonts.sans }]}
                value={editValue}
                onChangeText={setEditValue}
                autoFocus
                onSubmitEditing={handleSaveEdit}
                placeholder={editField === 'translation' ? 'Translation...' : 'Definition...'}
                placeholderTextColor={colors.textSecondary}
              />
              <TouchableOpacity style={[styles.editSaveBtn, { backgroundColor: colors.primary }]} onPress={handleSaveEdit}>
                <Text style={{ color: '#fff', fontFamily: fonts.sansMedium, fontSize: 13 }}>Save</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => setEditField(null)}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
          ) : (
            <View style={{ flexDirection: 'row', gap: 12, marginBottom: 8 }}>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                onPress={() => startEdit('translation')}
              >
                <Ionicons name="pencil-outline" size={14} color={colors.primary} />
                <Text style={{ fontSize: 12, color: colors.primary, fontFamily: fonts.sansMedium }}>
                  {word.translation ? 'Edit translation' : 'Add translation'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                onPress={() => startEdit('definition')}
              >
                <Ionicons name="pencil-outline" size={14} color={colors.primary} />
                <Text style={{ fontSize: 12, color: colors.primary, fontFamily: fonts.sansMedium }}>
                  {word.definition ? 'Edit definition' : 'Add definition'}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {word.definition && (
            <Text style={[styles.detailText, { color: colors.text, fontFamily: fonts.sans }]}>Definition: {word.definition}</Text>
          )}
          {word.sentence && (
            <Text style={[styles.detailText, { color: colors.text, fontFamily: fonts.sans, fontStyle: 'italic' }]}>"{word.sentence}"</Text>
          )}
          {word.bookTitle && (
            <Text style={[styles.detailSource, { color: colors.textSecondary, fontFamily: fonts.sans }]}>From: {word.bookTitle}</Text>
          )}
          {word.hint && (
            <Text style={[styles.detailHint, { color: colors.primary, fontFamily: fonts.sans }]}>Hint: {word.hint}</Text>
          )}
          <Text style={[styles.detailDate, { color: colors.textSecondary, fontFamily: fonts.sans }]}>
            Added {new Date(word.createdAt).toLocaleDateString()}
            {word.totalReviews > 0 && ` · ${plural(word.totalReviews, 'review', 'reviews')} (${word.correctReviews > 0 ? Math.round(word.correctReviews / word.totalReviews * 100) : 0}%)`}
            {word.nextReviewAt && ` · Due: ${new Date(word.nextReviewAt).toLocaleDateString()}`}
          </Text>
          <TouchableOpacity
            // Tinted from colors.error so the row survives dark mode; the confirm
            // state fills solid, which is why its label flips to white.
            style={[styles.deleteBtn, { backgroundColor: colors.error + '22' }, confirmingDelete && { backgroundColor: colors.error }]}
            onPress={handleDeletePress}
          >
            <Ionicons name="trash-outline" size={14} color={confirmingDelete ? '#fff' : colors.error} style={{ marginRight: 4 }} />
            <Text style={[styles.deleteBtnText, { fontFamily: fonts.sansMedium, color: colors.error }, confirmingDelete && { color: '#fff' }]}>
              {confirmingDelete ? 'Confirm Delete' : 'Delete Word'}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  emptyText: { fontSize: 16, textAlign: 'center' },
  emptySubtext: { fontSize: 13, marginTop: 4, textAlign: 'center' },


  // Stats
  statValue: { fontSize: 20 },
  statLabel: { fontSize: 11, marginTop: 2 },

  // Mode toggle
  // Context snippet
  contextText: { fontSize: 12, fontFamily: 'SourceSans3-Regular', marginTop: 2 },
  // Review buttons
  reviewBtn: {
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
  },
  reviewBtnText: { color: '#fff', fontSize: 15 },

  // Tabs
  tabsRow: { flexDirection: 'row', alignItems: 'center' },
  viewBtn: { paddingHorizontal: 12, paddingVertical: 10 },
  tabs: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: 16,
    paddingRight: 8,
    marginTop: 12,
    gap: 6,
  },
  // `flex: 1` used to be here, and it was correct while this row was a plain
  // flex container filling the screen. It became a horizontal ScrollView's
  // content container in #464, where the width is unbounded — so the chips
  // fought over a width that does not exist and the first one, "All", ended up
  // clipped by the left edge. Chips in a scrolling row size to their content.
  tab: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 6,
    alignItems: 'center',
    borderWidth: 1,
  },
  tabText: { fontSize: 13 },

  // Search + Sort
  searchSortRow: { paddingHorizontal: 16, marginTop: 12 },
  searchInput: {
    height: 40,
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 12,
    fontSize: 14,
  },

  // List
  listContent: { paddingBottom: 20 },
  wordRow: {
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: 1,
  },
  wordHeader: { flexDirection: 'row', alignItems: 'center' },
  wordText: { fontSize: 16 },
  wordTranslation: { fontSize: 13, marginTop: 2 },
  stageBadge: {
    paddingVertical: 3,
    paddingHorizontal: 8,
    borderRadius: 4,
  },
  stageText: { fontSize: 11 },

  // Detail
  wordDetail: { marginTop: 10, paddingTop: 10, borderTopWidth: 1 },
  detailText: { fontSize: 13, marginBottom: 4 },
  detailSource: { fontSize: 12, marginBottom: 4 },
  detailHint: { fontSize: 12, marginBottom: 4, fontStyle: 'italic' },
  detailDate: { fontSize: 11, marginBottom: 8 },
  editInput: {
    flex: 1,
    height: 36,
    borderRadius: 6,
    borderWidth: 1,
    paddingHorizontal: 10,
    fontSize: 13,
  },
  editSaveBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    justifyContent: 'center',
  },
  deleteBtn: {
    alignSelf: 'flex-start',
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
    flexDirection: 'row',
    alignItems: 'center',
  },
  deleteBtnText: { fontSize: 12 },
})
