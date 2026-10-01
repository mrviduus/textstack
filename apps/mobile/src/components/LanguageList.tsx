import { useState, useMemo, useImperativeHandle, forwardRef } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, FlatList, TextInput } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../context/ThemeContext'
import { fonts } from '../theme/typography'
import {
  LANGUAGES,
  POPULAR_LANGUAGES,
  OTHER_LANGUAGES,
  type LanguageEntry,
} from '@textstack/shared'

/**
 * The searchable language list, without any opinion about what contains it.
 *
 * It was born inside `LanguagePickerModal` and stayed there until onboarding
 * needed the same list on a full screen. Copying it would have meant two lists
 * drifting apart — the codebase has already paid for that with three text-anchor
 * implementations and two percent conventions.
 */

interface Props {
  value: string
  onSelect: (code: string) => void
  /** The modal autofocuses search; a first-run screen should not raise the
   *  keyboard over the question it just asked. */
  autoFocusSearch?: boolean
}

export interface LanguageListHandle {
  /** Clear the query — the modal calls this when it closes. */
  reset: () => void
}

type Row =
  | { kind: 'section'; title: string }
  | { kind: 'item'; lang: LanguageEntry }

export const LanguageList = forwardRef<LanguageListHandle, Props>(function LanguageList(
  { value, onSelect, autoFocusSearch = false },
  ref,
) {
  const { colors } = useTheme()
  const [query, setQuery] = useState('')

  useImperativeHandle(ref, () => ({ reset: () => setQuery('') }), [])

  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) {
      return [
        { kind: 'section', title: 'Popular' },
        ...POPULAR_LANGUAGES.map((lang) => ({ kind: 'item' as const, lang })),
        { kind: 'section', title: 'All languages' },
        ...OTHER_LANGUAGES.map((lang) => ({ kind: 'item' as const, lang })),
      ]
    }
    const filtered = LANGUAGES.filter(
      (l) =>
        l.englishName.toLowerCase().includes(q) ||
        l.nativeName.toLowerCase().includes(q) ||
        l.code.toLowerCase().startsWith(q),
    )
    return filtered.map((lang) => ({ kind: 'item' as const, lang }))
  }, [query])

  return (
    <>
      <View style={[styles.searchRow, { borderColor: colors.border }]}>
        <Ionicons name="search" size={18} color={colors.textSecondary} style={{ marginRight: 8 }} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder="Search language..."
          placeholderTextColor={colors.textSecondary}
          style={[styles.searchInput, { color: colors.text, fontFamily: fonts.sans }]}
          autoCorrect={false}
          autoCapitalize="none"
          autoFocus={autoFocusSearch}
          accessibilityLabel="Search language"
          returnKeyType="search"
        />
      </View>

      {rows.length === 0 ? (
        <Text style={[styles.empty, { color: colors.textSecondary }]}>
          No results for "{query.trim()}"
        </Text>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(item, i) =>
            item.kind === 'section' ? `section-${item.title}` : `item-${item.lang.code}-${i}`
          }
          keyboardShouldPersistTaps="handled"
          style={styles.list}
          renderItem={({ item }) => {
            if (item.kind === 'section') {
              return (
                <Text
                  style={[styles.sectionLabel, { color: colors.textSecondary }]}
                  accessibilityRole="header"
                >
                  {item.title}
                </Text>
              )
            }
            const lang = item.lang
            const selected = lang.code === value
            return (
              <TouchableOpacity
                style={[
                  styles.row,
                  { borderBottomColor: colors.border },
                  selected && { backgroundColor: colors.primaryLight },
                ]}
                onPress={() => onSelect(lang.code)}
                activeOpacity={0.7}
                accessibilityRole="button"
                accessibilityLabel={
                  lang.englishName === lang.nativeName
                    ? lang.nativeName
                    : `${lang.nativeName}, ${lang.englishName}`
                }
                accessibilityState={{ selected }}
              >
                <View style={{ flex: 1 }}>
                  <Text
                    style={[
                      styles.rowNative,
                      { color: colors.text, fontFamily: fonts.sansMedium },
                      selected && { color: colors.primary },
                    ]}
                  >
                    {lang.nativeName}
                  </Text>
                  {lang.englishName !== lang.nativeName && (
                    <Text style={[styles.rowEnglish, { color: colors.textSecondary, fontFamily: fonts.sans }]}>
                      {lang.englishName}
                    </Text>
                  )}
                </View>
                {selected && <Ionicons name="checkmark" size={20} color={colors.primary} />}
              </TouchableOpacity>
            )
          }}
        />
      )}
    </>
  )
})

const styles = StyleSheet.create({
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 8,
  },
  searchInput: { flex: 1, fontSize: 15, padding: 0 },
  list: { flex: 1 },
  sectionLabel: {
    fontSize: 11,
    textTransform: 'uppercase',
    letterSpacing: 0.8,
    fontFamily: fonts.sansMedium,
    paddingVertical: 8,
    paddingHorizontal: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    gap: 12,
    borderRadius: 4,
  },
  rowNative: { fontSize: 15 },
  rowEnglish: { fontSize: 12, marginTop: 2 },
  empty: { textAlign: 'center', padding: 24, fontSize: 14 },
})
