import { StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { fonts } from '../../theme/typography'

/**
 * The one card above the word list: Practice. V2 keeps no vocabulary stats (no due count, streak or level), so
 * the review session itself finds what is due.
 */
export function VocabSummaryCard({ onPractice }: { onPractice: () => void }) {
  const { colors } = useTheme()
  return (
    <View style={[styles.card, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <TouchableOpacity style={[styles.primary, { backgroundColor: colors.primary }]} onPress={onPractice} accessibilityRole="button">
        <Ionicons name="school-outline" size={17} color="#fff" />
        <Text style={styles.primaryText}>Practice</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 14,
    marginTop: 10,
    marginBottom: 4,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  primary: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    gap: 6, paddingVertical: 11, borderRadius: 8,
  },
  primaryText: { fontFamily: fonts.sansMedium, fontSize: 15, color: '#fff' },
})
