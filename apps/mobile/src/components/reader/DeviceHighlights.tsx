import { useCallback, useState } from 'react'
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { useFocusEffect, useRouter } from 'expo-router'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { fonts } from '../../theme/typography'
import { deviceLocalLibrary } from '../../lib/reader/deviceLibrary'
import { colorOf } from '../../../../../packages/reader/src/highlights.mjs'
import { HIGHLIGHT_BG } from '../../lib/readerColors'

type Item = { id: string; bookId: string; bookTitle: string; text: string; color: string; note: string | null }

/**
 * #1312 (audit §2.1): the highlights made in the V2 reader on this device, on the highlights screen of a dev build
 * (the V2 route is dev-only, `app/dev/epub.tsx`). A tap opens that route at the highlight (`?book=&highlight=`):
 * the book from this device, then the jump. Book text and notes as text only.
 */
export function DeviceHighlights() {
  const router = useRouter()
  const { colors } = useTheme()
  const { t } = useLanguage()
  const [items, setItems] = useState<Item[]>([])
  // Read again each time the screen is shown: back from the reader, its edits and removals are in (#1312 review).
  useFocusEffect(useCallback(() => {
    let live = true
    deviceLocalLibrary().deviceHighlights().then((x) => { if (live) setItems(x) }, (e) => console.warn('[v2] device highlights:', e))
    return () => { live = false }
  }, []))
  if (!items.length) return null
  return (
    <View style={styles.box}>
      <Text style={[styles.title, { color: colors.textSecondary }]}>{t('reader.v2.deviceHighlights')}</Text>
      {items.map((h) => (
        <TouchableOpacity
          key={h.id}
          style={[styles.row, { borderColor: colors.border }]}
          onPress={() => router.push(`/dev/epub?book=${encodeURIComponent(h.bookId)}&highlight=${encodeURIComponent(h.id)}`)}
          accessibilityRole="button"
        >
          <View style={[styles.swatch, { backgroundColor: HIGHLIGHT_BG[colorOf(h.color)] }]} />
          <View style={styles.body}>
            <Text style={[styles.text, { color: colors.text }]} numberOfLines={2}>{h.text}</Text>
            {h.note ? <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={1}>{h.note}</Text> : null}
            <Text style={[styles.meta, { color: colors.textSecondary }]} numberOfLines={1}>{h.bookTitle}</Text>
          </View>
        </TouchableOpacity>
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  box: { paddingHorizontal: 16, paddingTop: 10, gap: 6 },
  title: { fontSize: 12, fontFamily: fonts.sansMedium },
  row: { flexDirection: 'row', gap: 10, borderWidth: 1, borderRadius: 8, padding: 8, minHeight: 44 },
  swatch: { width: 6, alignSelf: 'stretch', borderRadius: 3 },
  body: { flex: 1, gap: 2 },
  text: { fontSize: 14, fontFamily: fonts.sans },
  meta: { fontSize: 12, fontFamily: fonts.sans },
})
