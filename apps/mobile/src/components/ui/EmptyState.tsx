import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { fonts } from '../../theme/typography'

type IoniconsName = React.ComponentProps<typeof Ionicons>['name']

interface EmptyStateProps {
  icon: IoniconsName
  title: string
  subtitle?: string
  buttonLabel?: string
  onButtonPress?: () => void
  /** A quieter second way out, under the button. Added because an empty
   *  library has two honest answers — add a book, or sign in to find the ones
   *  you already added — and offering only one of them sent a reader who just
   *  wanted to upload into a sign-up flow they did not need. */
  secondaryLabel?: string
  onSecondaryPress?: () => void
}

export function EmptyState({
  icon, title, subtitle, buttonLabel, onButtonPress, secondaryLabel, onSecondaryPress,
}: EmptyStateProps) {
  const { colors } = useTheme()
  return (
    <View style={styles.center}>
      <Ionicons name={icon} size={48} color={colors.textSecondary} style={{ marginBottom: 12 }} />
      <Text style={[styles.title, { color: colors.text }]}>{title}</Text>
      {subtitle ? (
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{subtitle}</Text>
      ) : null}
      {buttonLabel && onButtonPress ? (
        <TouchableOpacity
          style={[styles.button, { borderColor: colors.primary }]}
          onPress={onButtonPress}
        >
          <Text style={[styles.buttonText, { color: colors.primary }]}>{buttonLabel}</Text>
        </TouchableOpacity>
      ) : null}
      {secondaryLabel && onSecondaryPress ? (
        <TouchableOpacity onPress={onSecondaryPress} style={{ marginTop: 10 }} accessibilityRole="button">
          <Text style={[styles.subtitle, { color: colors.textSecondary, textDecorationLine: 'underline' }]}>
            {secondaryLabel}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 },
  title: { fontFamily: fonts.sansMedium, fontSize: 16, textAlign: 'center' },
  subtitle: { fontFamily: fonts.sans, fontSize: 13, textAlign: 'center', marginTop: 4 },
  button: {
    marginTop: 12,
    paddingVertical: 10,
    paddingHorizontal: 24,
    borderRadius: 8,
    borderWidth: 1,
  },
  buttonText: { fontFamily: fonts.sansMedium, fontSize: 14 },
})
