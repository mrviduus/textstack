import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { fonts } from '../../theme/typography'

/**
 * Says the app is offline and what that means for what is on screen.
 *
 * Lifted verbatim out of `app/book/[slug].tsx`, which was the only screen doing
 * this correctly. Library and Discover both had the information — `safeFetch`
 * sets `isNetworkError` on every failed request — and both threw it away in a
 * `console.error`, leaving their lists empty. An offline reader with twelve
 * books was shown the welcome screen written for someone with none, which is
 * indistinguishable from having lost the account.
 *
 * The message is a prop because the honest sentence differs per screen: the book
 * screen is showing downloaded content, the library may be showing a subset, and
 * Discover has nothing to show at all.
 */
export function OfflineBanner({
  message,
  actionLabel,
  onAction,
  signedOut = false,
}: {
  message: string
  /** Optional retry. A banner with no way out is a status light, not a control —
   *  Discover's sat on screen through the network coming back with nothing the
   *  reader could press. */
  actionLabel?: string
  onAction?: () => void
  /** Signed out, not offline (#1608): a person icon and no alert role — a status, not a problem. */
  signedOut?: boolean
}) {
  const { colors } = useTheme()
  return (
    <View
      style={[styles.banner, { backgroundColor: colors.primaryLight, borderColor: colors.primary }]}
      accessibilityRole={signedOut ? undefined : 'alert'}
    >
      <Ionicons name={signedOut ? 'person-circle-outline' : 'cloud-offline-outline'} size={16} color={colors.primary} />
      <Text style={[styles.text, { color: colors.primary }]}>{message}</Text>
      {actionLabel && onAction && (
        <TouchableOpacity onPress={onAction} hitSlop={8} accessibilityRole="button">
          <Text style={[styles.action, { color: colors.primary }]}>{actionLabel}</Text>
        </TouchableOpacity>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginHorizontal: 16,
    marginBottom: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
  },
  text: {
    fontFamily: fonts.sansMedium,
    fontSize: 13,
    flex: 1,
  },
  action: {
    fontFamily: fonts.sansBold,
    fontSize: 13,
    textDecorationLine: 'underline',
  },
})
