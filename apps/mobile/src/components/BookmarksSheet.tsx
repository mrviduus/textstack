import { View, Text, StyleSheet, TouchableOpacity, Modal, Pressable, FlatList } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { parsePdfPageLocator, bookmarkChapterSlug } from '@textstack/shared'
import type { BookmarkDto } from '@textstack/shared'
import { useTheme } from '../context/ThemeContext'
import { fonts } from '../theme/typography'

function getSlugFromLocator(locator: string): string {
  return bookmarkChapterSlug(locator)
}

interface Props {
  visible: boolean
  onClose: () => void
  bookmarks: BookmarkDto[]
  currentChapterSlug: string
  onNavigate: (chapterSlug: string) => void
  /** Jump the Original-layout PDF to a 1-based page (page bookmarks). */
  onNavigatePage?: (page: number) => void
  onDelete: (id: string) => void
  onToggleCurrent: () => void
  isCurrentBookmarked: boolean
  /** Original-layout PDF mode — the "add" button bookmarks the current PAGE and
   *  `page:<N>` bookmarks jump via `onNavigatePage`. */
  original?: boolean
}

export function BookmarksSheet({
  visible, onClose, bookmarks, currentChapterSlug,
  onNavigate, onNavigatePage, onDelete, onToggleCurrent, isCurrentBookmarked, original,
}: Props) {
  const { colors } = useTheme()

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
    >
      <Pressable
        style={styles.overlay}
        onPress={onClose}
        accessibilityRole="button"
        accessibilityLabel="Close bookmarks"
      >
        <Pressable style={[styles.sheet, { backgroundColor: colors.background }]} onPress={e => e.stopPropagation()}>
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: colors.border, alignSelf: 'center', marginBottom: 12 }} />
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">Bookmarks</Text>
            <TouchableOpacity
              style={[styles.addBtn, { backgroundColor: colors.primaryLight }]}
              onPress={onToggleCurrent}
              accessibilityRole="button"
              accessibilityLabel={isCurrentBookmarked ? 'Remove bookmark from this chapter' : 'Bookmark this chapter'}
              accessibilityState={{ selected: isCurrentBookmarked }}
            >
              <Text style={[styles.addBtnText, { color: colors.primary }]}>
                {isCurrentBookmarked ? 'Remove Bookmark' : original ? 'Bookmark This Page' : 'Bookmark This Chapter'}
              </Text>
            </TouchableOpacity>
          </View>

          {bookmarks.length === 0 ? (
            <Text style={[styles.empty, { color: colors.textSecondary }]}>No bookmarks yet</Text>
          ) : (
            <FlatList
              data={bookmarks}
              keyExtractor={item => item.id}
              style={styles.list}
              renderItem={({ item }) => {
                const page = parsePdfPageLocator(item.locator)
                const slug = getSlugFromLocator(item.locator)
                const isCurrent = page == null && slug === currentChapterSlug
                const go = () => {
                  if (page != null) onNavigatePage?.(page)
                  else onNavigate(slug)
                  onClose()
                }
                return (
                  <View style={[styles.row, { borderBottomColor: colors.border }]}>
                    <TouchableOpacity
                      style={styles.rowContent}
                      onPress={go}
                      accessibilityRole="button"
                      accessibilityLabel={`Go to bookmark: ${item.title}`}
                      accessibilityState={{ selected: isCurrent }}
                    >
                      <Text style={[
                        styles.rowTitle,
                        { color: colors.text },
                        isCurrent && { color: colors.primary, fontWeight: '600' },
                      ]} numberOfLines={1}>
                        {item.title}
                      </Text>
                      <Text style={[styles.rowDate, { color: colors.textSecondary }]}>
                        {new Date(item.createdAt).toLocaleDateString()}
                      </Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      style={styles.deleteBtn}
                      onPress={() => onDelete(item.id)}
                      accessibilityRole="button"
                      accessibilityLabel={`Delete bookmark: ${item.title}`}
                    >
                      <Ionicons name="close" size={18} color={colors.error} />
                    </TouchableOpacity>
                  </View>
                )
              }}
            />
          )}

          <TouchableOpacity
            style={[styles.closeBtn, { backgroundColor: colors.primary }]}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close bookmarks"
          >
            <Text style={styles.closeBtnText}>Done</Text>
          </TouchableOpacity>
        </Pressable>
      </Pressable>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 20,
    paddingBottom: 40,
    maxHeight: '70%',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: { fontSize: 18, fontFamily: fonts.sansBold },
  addBtn: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: 6,
  },
  addBtnText: { fontSize: 12, fontFamily: fonts.sansBold },
  empty: { fontSize: 14, textAlign: 'center', marginVertical: 20 },
  list: { maxHeight: 300 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
  },
  rowContent: { flex: 1 },
  rowTitle: { fontSize: 15 },
  rowDate: { fontSize: 11, marginTop: 2 },
  deleteBtn: { padding: 8 },
  closeBtn: {
    marginTop: 16,
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  closeBtnText: { color: '#fff', fontSize: 16, fontFamily: fonts.sansBold },
})
