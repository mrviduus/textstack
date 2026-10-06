import { useRef } from 'react'
import { View, Text, Modal, TouchableOpacity, FlatList, StyleSheet, ActivityIndicator } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../context/ThemeContext'
import { fonts } from '../theme/typography'

interface TocChapter {
  slug: string
  title: string
  chapterNumber?: number
}

interface TocSheetProps {
  visible: boolean
  chapters: TocChapter[]
  currentChapterSlug: string
  bookmarks?: Array<{ chapterSlug: string; title?: string }>
  onNavigate: (slug: string) => void
  onClose: () => void
  /** True while chapter list is still being fetched. When chapters is empty
   * AND loading, we show a spinner; empty + not-loading means "no chapters
   * available" (extractor produced none / API failed). */
  loading?: boolean
}

export function TocSheet({ visible, chapters, currentChapterSlug, bookmarks, onNavigate, onClose, loading }: TocSheetProps) {
  const { colors } = useTheme()
  const listRef = useRef<FlatList<TocChapter>>(null)
  // One scroll to the current chapter per opening (a closed Modal unmounts the list).
  const scrolledRef = useRef(false)
  if (!visible) scrolledRef.current = false

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <View style={[styles.sheet, { backgroundColor: colors.background }, chapters.length > 0 && styles.sheetTall]}>
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginTop: 12 }} />
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">Contents</Text>
            <TouchableOpacity
              onPress={onClose}
              style={{ padding: 4 }}
              accessibilityRole="button"
              accessibilityLabel="Close table of contents"
            >
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>

          {chapters.length === 0 ? (
            <View style={styles.emptyWrap}>
              {loading ? (
                <>
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                  <Text style={[styles.emptyText, { color: colors.textSecondary }]}>Loading chapters…</Text>
                </>
              ) : (
                <>
                  <Ionicons name="list-outline" size={32} color={colors.textSecondary} />
                  <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                    No chapters available for this book.
                  </Text>
                </>
              )}
            </View>
          ) : (
          <FlatList
            ref={listRef}
            data={chapters}
            keyExtractor={(item) => item.slug}
            renderItem={({ item, index }) => {
              const isCurrent = item.slug === currentChapterSlug
              const hasBookmark = bookmarks?.some(b => b.chapterSlug === item.slug)
              return (
                <TouchableOpacity
                  style={[
                    styles.row,
                    { borderBottomColor: colors.border },
                    isCurrent && { backgroundColor: colors.primaryLight },
                  ]}
                  onPress={() => { onNavigate(item.slug); onClose() }}
                  accessibilityRole="button"
                  accessibilityLabel={`Chapter ${index + 1}: ${item.title}${hasBookmark ? ', bookmarked' : ''}`}
                  accessibilityState={{ selected: isCurrent }}
                >
                  <Text style={[styles.chapterNum, { color: colors.textSecondary }]}>{index + 1}</Text>
                  <Text style={[
                    styles.chapterTitle,
                    { color: colors.text },
                    isCurrent && { fontFamily: fonts.sansBold, color: colors.primary },
                  ]} numberOfLines={2}>
                    {item.title}
                  </Text>
                  {hasBookmark && <Ionicons name="bookmark" size={14} color={colors.primary} style={{ marginLeft: 8 }} />}
                </TouchableOpacity>
              )
            }}
            style={styles.list}
            // getItemLayout was lying — rows with numberOfLines={2} are
            // taller than 52 whenever the title wraps, which threw
            // initialScrollIndex offsets off by a growing amount and
            // produced blank sections at the bottom (B-14). Dropping it
            // lets FlatList measure; onScrollToIndexFailed handles the
            // edge where the target hasn't been laid out yet.
            // NOT initialScrollIndex: without getItemLayout FlatList mounts only the rows from that
            // index on, so the rows above were never there and the sheet could not scroll to them
            // ("only some chapters are visible"). The list mounts from the top, then scrolls.
            onLayout={() => {
              if (scrolledRef.current) return
              scrolledRef.current = true
              const index = Math.max(0, chapters.findIndex(c => c.slug === currentChapterSlug) - 2)
              if (index > 0) listRef.current?.scrollToIndex({ index, animated: false })
            }}
            onScrollToIndexFailed={info => {
              // Two-step recovery (P2-1): first jump to the approximate
              // offset so FlatList renders the target region, then retry
              // the exact index once layout has settled. Without the
              // retry the sheet lands a few rows above the current
              // chapter on first open.
              const approxOffset = info.averageItemLength * info.index
              listRef.current?.scrollToOffset({ offset: approxOffset, animated: false })
              setTimeout(() => {
                try {
                  listRef.current?.scrollToIndex({ index: info.index, animated: false })
                } catch {
                  /* sheet closed or list unmounted — ignore */
                }
              }, 100)
            }}
          />
          )}
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    maxHeight: '70%',
    // Min height keeps the empty/loading state visible — without it the sheet
    // collapses to just the header when chapters=[] and looks broken (B-?? from
    // mobile bug sweep).
    minHeight: 200,
    paddingBottom: 32,
  },
  // When chapters exist, give the sheet a DEFINITE height so the FlatList
  // (flex:1) has a bounded region to fill and scroll. With only maxHeight the
  // list collapsed to ~2 rows and didn't scroll — long TOCs were unreachable.
  sheetTall: {
    height: '88%',
    maxHeight: '88%',
  },
  emptyWrap: {
    flex: 1,
    minHeight: 120,
    justifyContent: 'center',
    alignItems: 'center',
    gap: 10,
    padding: 24,
  },
  emptyText: {
    fontSize: 14,
    fontFamily: fonts.sans,
    textAlign: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
  },
  title: { fontSize: 17, fontFamily: fonts.sansBold },
  list: { flex: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    // minHeight (not fixed height) so a chapter title that wraps to 2 lines
    // (numberOfLines={2}) isn't clipped — long titles were cut off mid-row.
    minHeight: 52,
  },
  chapterNum: {
    width: 28,
    fontSize: 13,
    fontFamily: fonts.sansMedium,
  },
  chapterTitle: {
    flex: 1,
    fontSize: 14,
  },
})
