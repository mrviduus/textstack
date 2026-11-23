import { useRef, type ReactElement, type ReactNode } from 'react'
import { FlatList, Modal, Pressable, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { useReduceMotion } from '../../hooks/useReduceMotion'
import { fonts } from '../../theme/typography'
import { tocAround, withTitle, type TocEntry } from '../../../../../packages/reader/src/toc.mjs'
import type { HighlightItem } from '../../../../../packages/reader/src/highlights.mjs'
import type { BookmarkItem } from '../../../../../packages/reader/src/bookmarks.mjs'
import { HIGHLIGHT_BG } from '../../lib/readerColors'

/** `toc` through `readToc`, `tocIndex` through `readRelocate` (toc.mjs: the book is untrusted); `onGo`: the entry the reader chose. */
interface Props {
  toc: TocEntry[]
  tocIndex: number | null
  onGo: (entry: TocEntry) => void
}

/**
 * The V2 reader's table of contents (#1261): the legacy TocSheet's modal (back and a tap outside close it, TalkBack
 * stays inside it), the entries indented by depth, the current one marked and scrolled to. No row number.
 */
export function TocSheet({ visible, toc, tocIndex, onGo, onClose }: Props & { visible: boolean; onClose: () => void }) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const reduceMotion = useReduceMotion()
  const list = useRef<FlatList<TocEntry>>(null)
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
 * The shell of a list sheet (the highlights', the bookmarks'): the contents sheet's modal (back and a tap outside close
 * it, TalkBack stays inside it), a title, an optional header action beside the close button, the list or its empty text.
 */
function ListSheet<T extends { id: string }>({ visible, title, closeLabel, action, items, empty, renderItem, onClose }: {
  visible: boolean
  title: string
  closeLabel: string
  action?: ReactNode
  items: T[]
  empty: string
  renderItem: (item: T) => ReactElement
  onClose: () => void
}) {
  const { colors } = useTheme()
  const reduceMotion = useReduceMotion()
  return (
    <Modal visible={visible} animationType={reduceMotion ? 'none' : 'slide'} transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.outside} onPress={onClose} accessible={false} />
        <View style={[styles.sheet, { backgroundColor: colors.background }]} accessibilityViewIsModal>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <Text style={[styles.title, { color: colors.text }]} accessibilityRole="header">{title}</Text>
            <View style={styles.headerActions}>
              {action}
              <TouchableOpacity onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel={closeLabel}>
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
          </View>
          {items.length === 0 ? (
            <Text style={[styles.empty, { color: colors.textSecondary }]}>{empty}</Text>
          ) : (
            <FlatList data={items} keyExtractor={(x) => x.id} style={styles.list} renderItem={({ item }) => renderItem(item)} />
          )}
        </View>
      </View>
    </Modal>
  )
}

/**
 * The open book's highlights (#1312): the page's `highlight-list` in book order, each highlight's text and note as
 * text (untrusted), its colour as a swatch. A tap jumps there and closes the sheet.
 */
export function HighlightsSheet({ visible, items, noteOf, onGo, onClose }: {
  visible: boolean
  items: HighlightItem[]
  /** A highlight's note (null: none), by the page's id. */
  noteOf: (id: string) => string | null
  onGo: (item: HighlightItem) => void
  onClose: () => void
}) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  return (
    <ListSheet
      visible={visible}
      title={t('reader.chrome.highlights')}
      closeLabel={t('reader.chrome.closeHighlights')}
      items={items}
      empty={t('highlights.emptySubtitle')}
      onClose={onClose}
      renderItem={(item) => {
        const note = noteOf(item.id)
        return (
          <TouchableOpacity
            style={[styles.row, styles.hlRow, { borderBottomColor: colors.border }]}
            // #1195: a quotation (the earlier reader's highlight) is listed, never drawn: nowhere to go.
            disabled={item.quotation}
            onPress={() => {
              onGo(item)
              onClose()
            }}
            accessibilityRole={item.quotation ? 'text' : 'button'}
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
  )
}

/**
 * The open book's bookmarks (#1314). Its header button adds a bookmark at the place being read, or removes the one
 * that place has (`here`; absent where nothing can be bookmarked and none is here). The page's `bookmark-list` in book
 * order, each bookmark's first words as text (untrusted): a tap jumps there and closes the sheet; its remove button
 * removes that one, wherever in the book it is (one further down the screen is never the one `here`).
 */
export function BookmarksSheet({ visible, items, here, can, placing, onToggle, onGo, onRemove, onClose }: {
  visible: boolean
  items: BookmarkItem[]
  /** The bookmark the place being read has (null: none). */
  here: string | null
  /** One can be made at the place on screen. */
  can: boolean
  /** Bookmarks are still being placed: the empty list says they are loading. */
  placing: boolean
  onToggle: () => void
  onGo: (item: BookmarkItem) => void
  onRemove: (id: string) => void
  onClose: () => void
}) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  return (
    <ListSheet
      visible={visible}
      title={t('reader.chrome.bookmarks')}
      closeLabel={t('reader.chrome.closeBookmarks')}
      items={items}
      empty={t(placing ? 'reader.chrome.bookmarksLoading' : can ? 'reader.chrome.bookmarksEmpty' : 'reader.chrome.bookmarksNotHere')}
      onClose={onClose}
      action={(can || here) ? (
        <TouchableOpacity
          onPress={onToggle}
          style={[styles.toggle, { backgroundColor: colors.primaryLight }]}
          accessibilityRole="button"
          accessibilityState={{ selected: !!here }}
          testID="v2-bookmark-toggle"
        >
          {/* One name, its state in `selected` (#1314 review); filled while the place being read has one. */}
          <Ionicons name={here ? 'bookmark' : 'bookmark-outline'} size={16} color={colors.primary} />
          <Text style={[styles.toggleText, { color: colors.primary }]}>{t('reader.chrome.bookmark')}</Text>
        </TouchableOpacity>
      ) : null}
      renderItem={(item) => (
        <View style={[styles.bmRow, { borderBottomColor: colors.border }, item.id === here && { backgroundColor: colors.primaryLight }]}>
          <TouchableOpacity
            style={[styles.row, styles.hlRow, styles.bmGo]}
            onPress={() => {
              onGo(item)
              onClose()
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: item.id === here }}
            testID="v2-bookmark-row"
          >
            <Ionicons name="bookmark" size={16} color={colors.textSecondary} />
            <Text style={[styles.rowText, styles.hlBody, { color: colors.text }]} numberOfLines={3}>{item.text}</Text>
          </TouchableOpacity>
          {/* Named by the bookmark's words: TalkBack tells the rows' buttons apart. */}
          <TouchableOpacity onPress={() => onRemove(item.id)} style={styles.close} accessibilityRole="button" accessibilityLabel={`${t('reader.chrome.removeBookmark')}: ${item.text}`} testID="v2-bookmark-remove">
            <Ionicons name="trash-outline" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      )}
    />
  )
}

/**
 * The entries before and after the reader's place, by title (#1261): never a number. Nothing on a book with no
 * contents. A row of the footer (ReaderFooter `above`).
 */
export function SectionNav({ toc, tocIndex, onGo, color }: Props & { color: string }) {
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
  toggle: { minHeight: 44, paddingHorizontal: 12, borderRadius: 8, flexDirection: 'row', alignItems: 'center', gap: 6 },
  toggleText: { fontSize: 14, fontFamily: fonts.sansMedium },
  bmRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth },
  bmGo: { flex: 1, borderBottomWidth: 0 },
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
