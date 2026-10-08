import { ScrollView, View, TouchableOpacity, Text, StyleSheet } from 'react-native'
import { useTheme } from '../../context/ThemeContext'
import { fonts } from '../../theme/typography'

interface ChipOption {
  key: string
  label: string
}

interface FilterChipsProps {
  options: ChipOption[]
  selected: string
  onSelect: (key: string) => void
  scrollable?: boolean
}

export function FilterChips({ options, selected, onSelect, scrollable = true }: FilterChipsProps) {
  const { colors } = useTheme()

  const chips = options.map(opt => {
    const isActive = selected === opt.key
    return (
      <TouchableOpacity
        key={opt.key}
        onPress={() => onSelect(opt.key)}
        style={[
          styles.chip,
          {
            backgroundColor: isActive ? colors.primary : colors.surface,
            borderColor: isActive ? colors.primary : colors.border,
          },
        ]}
      >
        <Text style={[styles.chipText, { color: isActive ? '#fff' : colors.textSecondary }]}>
          {opt.label}
        </Text>
      </TouchableOpacity>
    )
  })

  if (scrollable) {
    return (
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        // Its own height only: a ScrollView in a flex column grows (chips stretched tall) and,
        // with flexGrow 0 alone, shrinks under a long list (labels cut). Neither.
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
      >
        {chips}
      </ScrollView>
    )
  }

  return <View style={styles.row}>{chips}</View>
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0, flexShrink: 0 },
  scrollContent: { paddingHorizontal: 16, paddingVertical: 8, gap: 6, alignItems: 'center' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 1,
  },
  chipText: { fontFamily: fonts.sansMedium, fontSize: 12 },
})
