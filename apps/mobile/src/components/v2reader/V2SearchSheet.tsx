import { useEffect, useRef, useState } from 'react'
import { FlatList, Modal, Pressable, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { useReduceMotion } from '../../hooks/useReduceMotion'
import { fonts } from '../../theme/typography'
import { fill } from '../../lib/fill'
import { MAX_QUERY, SEARCH_DEBOUNCE_MS, readQuery, searchStatusKeys, type Search } from '../../../../../packages/reader/src/search.mjs'

/** search.mjs `searchStatusKeys` in the reader's words. */
const STATUS = { tooShort: 'reader.v2.searchTooShort', searching: 'reader.v2.searching', none: 'reader.v2.searchNone', count: 'reader.v2.searchCount', more: 'reader.v2.searchMore' } as const

/** The line under the field (`searchStatusKeys`), and that part of the book could not be read, once the search ended. */
export function searchStatus(search: Search, typed: string, t: (key: string) => string): string {
  const { status, incomplete } = searchStatusKeys(search, typed)
  const line = status ? fill(t(STATUS[status]), { count: search.results.length }) : ''
  return incomplete ? `${line} ${t('reader.v2.searchIncomplete')}` : line
}

/**
 * The V2 reader's in-book search (#1315): the contents sheet's modal (back and a tap outside close it, TalkBack stays
 * inside it). The page searches the whole book and streams its hits (`search-results`, read by the host through
 * `readSearchResults`); each is listed with the text around it and its section's title, as text (the book is
 * untrusted). A tap jumps there and closes the sheet; the search stays, so the sheet opens again on the same results.
 * The host keys it by the open: a new book's sheet starts empty.
 */
export function V2SearchSheet({ visible, search, onQuery, onGo, onClose }: {
  visible: boolean
  /** The host's search (search.mjs): the query the page was asked, its results so far. */
  search: Search
  /** What the reader typed, debounced; '' clears the search and the hits drawn in the book. */
  onQuery: (raw: string) => void
  onGo: (result: { cfi: string }) => void
  onClose: () => void
}) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const reduceMotion = useReduceMotion()
  const [text, setText] = useState(search.query)
  const onQueryRef = useRef(onQuery)
  onQueryRef.current = onQuery
  const asked = useRef(search.query)
  asked.current = search.query
  // Asked only when what was typed is another query than the one the page has (reopening the sheet asks nothing).
  useEffect(() => {
    const id = setTimeout(() => {
      if ((readQuery(text) ?? '') !== asked.current) onQueryRef.current(text)
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [text])
  const status = searchStatus(search, text, t)

  return (
    <Modal visible={visible} animationType={reduceMotion ? 'none' : 'slide'} transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={styles.outside} onPress={onClose} accessible={false} />
        <View style={[styles.sheet, { backgroundColor: colors.background }]} accessibilityViewIsModal>
          <View style={[styles.header, { borderBottomColor: colors.border }]}>
            <TextInput
              value={text}
              onChangeText={setText}
              // A sheet reopened on its results keeps the keyboard down: the rows under it are reachable.
              autoFocus={!search.query}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              maxLength={MAX_QUERY}
              placeholder={t('reader.v2.searchPlaceholder')}
              placeholderTextColor={colors.textSecondary}
              accessibilityLabel={t('reader.v2.searchLabel')}
              style={[styles.input, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
            />
            {text ? (
              <TouchableOpacity onPress={() => setText('')} style={styles.close} accessibilityRole="button" accessibilityLabel={t('reader.v2.searchClear')}>
                <Ionicons name="close-circle-outline" size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity onPress={onClose} style={styles.close} accessibilityRole="button" accessibilityLabel={t('reader.v2.searchClose')}>
              <Ionicons name="close" size={22} color={colors.textSecondary} />
            </TouchableOpacity>
          </View>
          {/* Always mounted: a live region announces a change of its text. */}
          <Text style={[styles.status, { color: colors.textSecondary }]} accessibilityLiveRegion="polite">{status}</Text>
          <FlatList
            data={search.results}
            keyExtractor={(r) => r.cfi}
            style={styles.list}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[styles.row, { borderBottomColor: colors.border }]}
                onPress={() => {
                  onGo(item)
                  onClose()
                }}
                accessibilityRole="button"
              >
                {item.label ? <Text style={[styles.label, { color: colors.textSecondary }]} numberOfLines={1}>{item.label}</Text> : null}
                <Text style={[styles.rowText, { color: colors.text }]} numberOfLines={3}>
                  {item.pre}
                  <Text style={[styles.match, { backgroundColor: colors.primaryLight, color: colors.primary }]}>{item.match}</Text>
                  {item.post}
                </Text>
              </TouchableOpacity>
            )}
          />
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)' },
  outside: { flex: 1 },
  // A definite height: the list (flex 1) needs a bounded region to fill and scroll (V2TocSheet).
  sheet: { height: '80%', borderTopLeftRadius: 16, borderTopRightRadius: 16, paddingBottom: 32 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 16, paddingRight: 4, paddingVertical: 8, borderBottomWidth: 1 },
  input: { flex: 1, minHeight: 44, borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, fontSize: 16, fontFamily: fonts.sans },
  close: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  status: { paddingHorizontal: 16, paddingVertical: 8, fontSize: 13, fontFamily: fonts.sans },
  list: { flex: 1 },
  row: { justifyContent: 'center', paddingHorizontal: 16, paddingVertical: 12, minHeight: 52, gap: 2, borderBottomWidth: StyleSheet.hairlineWidth },
  label: { fontSize: 12, fontFamily: fonts.sans },
  rowText: { fontSize: 14, fontFamily: fonts.sans },
  match: { fontFamily: fonts.sansBold },
})
