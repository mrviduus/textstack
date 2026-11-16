import { useRef } from 'react'
import { FlatList, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { useReduceMotion } from '../../hooks/useReduceMotion'
import { fonts } from '../../theme/typography'
import { tocAround, withTitle, type V2TocEntry } from '../../lib/v2reader/toc.mjs'
import type { V2HighlightItem } from '../../lib/v2reader/highlights.mjs'
import type { V2BookmarkItem } from '../../lib/v2reader/bookmarks.mjs'
import { HIGHLIGHT_BG } from '../../lib/readerColors'

/** `toc` through `readToc`, `tocIndex` through `readRelocate` (toc.mjs: the book is untrusted); `onGo`: the entry the reader chose. */
interface Props {
  toc: V2TocEntry[]
  tocIndex: number | null
  onGo: (entry: V2TocEntry) => void
}

/**
 * The V2 reader's table of contents (#1261): the legacy TocSheet's modal (back and a tap outside close it, TalkBack
 * stays inside it), the entries indented by depth, the current one marked and scrolled to. No row number.
 */
export function V2TocSheet({ visible, toc, tocIndex, onGo, onClose }: Props & { visible: boolean; onClose: () => void }) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const reduceMotion = useReduceMotion()
  const list = useRef<FlatList<V2TocEntry>>(null)
  // One scroll to the current entry per opening (a closed Modal unmounts the list).
  const scrolled = useRef(false)
  if (!visible) scrolled.current = false
  const { current } = tocAround(toc, tocIndex)

  return (
    <Modal visible={visible} animationType={reduceMotion ? 'none' : 'slide'} transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.outside} onPress={onClose} accessible={false} />
        <View style={[styles.sheet, { backgroundColor: colors.background }]} accessibilityViewIsModal>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">{t('reader.chrome.contents')}</Text>
            <TouchableOpacity onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel={t('reader.chrome.closeContents')}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          <FlatList
            ref={list}
            data={toc}
            keyExtractor={(e) => String(e.index)}
            style={styles.list}
            renderItem={({ item }) => {
              const isCurrent = item === current
              return (
                <TouchableOpacity
                  style={[styles.row, { borderBottomColor: colors.border, paddingLeft: 16 + item.depth * 16 }, isCurrent && { backgroundColor: colors.primaryLight }]}
                  onPress={() => {
                    onGo(item)
                    onClose()
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={item.label}
                  accessibilityState={{ selected: isCurrent }}
                >
                  <Text style={[styles.rowText, { color: colors.text }, isCurrent && { fontFamily: fonts.sansBold, color: colors.primary }]} numberOfLines={2}>
                    {item.label}
                  </Text>
                </TouchableOpacity>
              )
            }}
            // As TocSheet: rows are measured (a title may wrap), so the list mounts from the top, then scrolls.
            onLayout={() => {
              if (scrolled.current) return
              scrolled.current = true
              const index = (current ? toc.indexOf(current) : 0) - 2
              if (index > 0) list.current?.scrollToIndex({ index, animated: false })
            }}
            onScrollToIndexFailed={(info) => {
              list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false })
              setTimeout(() => {
                try { list.current?.scrollToIndex({ index: info.index, animated: false }) } catch { /* the sheet closed */ }
              }, 100)
            }}
          />
        </View>
      </View>
    </Modal>
  )
}

/**
 * The open book's highlights (#1312): the contents sheet's modal, the page's `highlight-list` in book order, each
 * highlight's text and note as text (untrusted), its colour as a swatch. A tap jumps there and closes the sheet.
 */
export function V2HighlightsSheet({ visible, items, noteOf, onGo, onClose }: {
  visible: boolean
  items: V2HighlightItem[]
  /** A highlight's note (null: none), by the page's id. */
  noteOf: (id: string) => string | null
  onGo: (item: V2HighlightItem) => void
  onClose: () => void
}) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const reduceMotion = useReduceMotion()
  return (
    <Modal visible={visible} animationType={reduceMotion ? 'none' : 'slide'} transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.outside} onPress={onClose} accessible={false} />
        <View style={[styles.sheet, { backgroundColor: colors.background }]} accessibilityViewIsModal>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">{t('reader.chrome.highlights')}</Text>
            <TouchableOpacity onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel={t('reader.chrome.closeHighlights')}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          {items.length === 0 ? (
            <Text style={[styles.empty, { color: colors.textSecondary }]}>{t('highlights.emptySubtitle')}</Text>
          ) : (
            <FlatList
              data={items}
              keyExtractor={(h) => h.id}
              style={styles.list}
              renderItem={({ item }) => {
                const note = noteOf(item.id)
                return (
                  <TouchableOpacity
                    style={[styles.row, styles.hlRow, { borderBottomColor: colors.border }]}
                    onPress={() => {
                      onGo(item)
                      onClose()
                    }}
                    accessibilityRole="button"
                  >
                    <View style={[styles.swatch, { backgroundColor: HIGHLIGHT_BG[item.color] }]} />
                    <View style={styles.hlBody}>
                      <Text style={[styles.rowText, { color: colors.text }]} numberOfLines={3}>{item.text}</Text>
                      {note ? <Text style={[styles.note, { color: colors.textSecondary }]} numberOfLines={2}>{note}</Text> : null}
                    </View>
                  </TouchableOpacity>
                )
              }}
            />
          )}
        </View>
      </View>
    </Modal>
  )
}

/**
 * The open book's bookmarks (#1314): the contents sheet's modal. Its header button adds a bookmark at the place on
 * screen, or removes the one there (`here`; absent where there is nothing to bookmark and none here). The page's
 * `bookmark-list` in book order, each bookmark's first words as text (untrusted); a tap jumps there and closes the sheet.
 */
export function V2BookmarksSheet({ visible, items, here, can, onToggle, onGo, onClose }: {
  visible: boolean
  items: V2BookmarkItem[]
  /** The bookmark on screen (null: none). */
  here: string | null
  /** One can be made at the place on screen. */
  can: boolean
  onToggle: () => void
  onGo: (item: V2BookmarkItem) => void
  onClose: () => void
}) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const reduceMotion = useReduceMotion()
  return (
    <Modal visible={visible} animationType={reduceMotion ? 'none' : 'slide'} transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.outside} onPress={onClose} accessible={false} />
        <View style={[styles.sheet, { backgroundColor: colors.background }]} accessibilityViewIsModal>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">{t('reader.chrome.bookmarks')}</Text>
            <View style={styles.headerActions}>
              {(can || here) && (
                <TouchableOpacity
                  onPress={onToggle}
                  style={[styles.toggle, { backgroundColor: colors.primaryLight }]}
                  accessibilityRole="button"
                  accessibilityState={{ selected: !!here }}
                  testID="v2-bookmark-toggle"
                >
                  <Text style={[styles.toggleText, { color: colors.primary }]}>{t(here ? 'reader.chrome.removeBookmark' : 'reader.chrome.addBookmark')}</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel={t('reader.chrome.closeBookmarks')}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
          </View>
          {items.length === 0 ? (
            <Text style={[styles.empty, { color: colors.textSecondary }]}>{t('reader.chrome.bookmarksEmpty')}</Text>
          ) : (
            <FlatList
              data={items}
              keyExtractor={(b) => b.id}
              style={styles.list}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.row, styles.hlRow, { borderBottomColor: colors.border }, item.id === here && { backgroundColor: colors.primaryLight }]}
                  onPress={() => {
                    onGo(item)
                    onClose()
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: item.id === here }}
                >
                  <Ionicons name="bookmark" size={16} color={colors.textSecondary} />
                  <Text style={[styles.rowText, styles.hlBody, { color: colors.text }]} numberOfLines={3}>{item.text}</Text>
                </TouchableOpacity>
              )}
            />
          )}
        </View>
      </View>
    </Modal>
  )
}

/**
 * The entries before and after the reader's place, by title (#1261): never a number. Nothing on a book with no
 * contents. A row of the footer (ReaderFooter `above`).
 */
export function V2SectionNav({ toc, tocIndex, onGo, color }: Props & { color: string }) {
  const { t } = useLanguage()
  const { prev, next } = tocAround(toc, tocIndex)
  if (!prev && !next) return null
  return (
    <View style={styles.sections}>
      {prev ? (
        <TouchableOpacity
          style={styles.section}
          onPress={() => onGo(prev)}
          accessibilityRole="button"
          accessibilityLabel={withTitle(t('reader.chrome.prevSection'), prev.label)}
        >
          <Text style={[styles.sectionText, { color }]} numberOfLines={1}>‹ {prev.label}</Text>
        </TouchableOpacity>
      ) : <View style={styles.section} />}
      {next ? (
        <TouchableOpacity
          style={styles.section}
          onPress={() => onGo(next)}
          accessibilityRole="button"
          accessibilityLabel={withTitle(t('reader.chrome.nextSection'), next.label)}
        >
          <Text style={[styles.sectionText, styles.sectionNext, { color }]} numberOfLines={1}>{next.label} ›</Text>
        </TouchableOpacity>
      ) : <View style={styles.section} />}
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  outside: { flex: 1 },
  // A definite height: the list (flex 1) needs a bounded region to fill and scroll (TocSheet).
  sheet: { height: '80%', borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 32 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingLeft: 16, paddingRight: 4, borderBottomWidth: 1 },
  title: { fontSize: 17, fontFamily: fonts.sansBold },
  close: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  toggle: { minHeight: 44, paddingHorizontal: 12, borderRadius: 8, justifyContent: 'center' },
  toggleText: { fontSize: 14, fontFamily: fonts.sansMedium },
  list: { flex: 1 },
  row: { justifyContent: 'center', paddingRight: 16, paddingVertical: 14, minHeight: 52, borderBottomWidth: StyleSheet.hairlineWidth },
  rowText: { fontSize: 14, fontFamily: fonts.sans },
  sections: { flexDirection: 'row', gap: 12, paddingHorizontal: 12 },
  section: { flex: 1, minHeight: 44, justifyContent: 'center' },
  sectionText: { fontSize: 13, fontFamily: fonts.sans },
  sectionNext: { textAlign: 'right' },
  hlRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingLeft: 16 },
  hlBody: { flex: 1, gap: 4 },
  swatch: { width: 6, alignSelf: 'stretch', borderRadius: 3 },
  note: { fontSize: 13, fontFamily: fonts.sans, fontStyle: 'italic' },
  empty: { padding: 24, fontSize: 14, fontFamily: fonts.sans, textAlign: 'center' },
})
