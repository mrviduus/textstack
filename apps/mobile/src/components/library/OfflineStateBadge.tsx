import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'
import { fonts } from '../../theme/typography'
import type { OfflineState } from '../../lib/offlineState'

/**
 * Where this book actually is, said on the shelf.
 *
 * The library downloads itself now, and until this existed nothing on screen
 * admitted it: a reader could not tell what was on the phone, what was arriving
 * and what still needed a connection. That is the half of the Kindle model
 * worth copying — the state is legible from the list, and the action is one tap
 * from the same place, rather than three taps inside the book.
 *
 * `in-cloud` renders an ACTION, not a label. "This book is not here" is only
 * worth saying if the next thing the reader can do is fix it.
 */
export function OfflineStateBadge({
  state,
  percent,
  onDownload,
}: {
  state: OfflineState
  /** 0-100 while downloading. */
  percent?: number | null
  /** Omitted when the row cannot start one — then `in-cloud` stays silent
   *  rather than offering something that does nothing. */
  onDownload?: () => void
}) {
  const { colors } = useTheme()

  if (state === 'on-device') {
    return (
      <View style={styles.row} accessibilityLabel="Available offline">
        <Ionicons name="checkmark-circle" size={13} color={colors.success} />
        <Text style={[styles.text, { color: colors.success }]}>On this device</Text>
      </View>
    )
  }

  if (state === 'downloading') {
    return (
      <View style={styles.row} accessibilityLabel="Downloading">
        <Ionicons name="arrow-down-circle-outline" size={13} color={colors.primary} />
        <Text style={[styles.text, { color: colors.primary }]}>
          {typeof percent === 'number' ? `Downloading ${percent}%` : 'Downloading'}
        </Text>
      </View>
    )
  }

  if (state === 'partial') {
    // Deliberately not "in the cloud": the reader can finish this one, and
    // calling a half-downloaded book absent is a lie the next flight exposes.
    return (
      <TouchableOpacity
        style={styles.row}
        onPress={onDownload}
        disabled={!onDownload}
        accessibilityRole={onDownload ? 'button' : undefined}
        accessibilityLabel="Finish downloading"
      >
        <Ionicons name="pause-circle-outline" size={13} color={colors.warning} />
        <Text style={[styles.text, { color: colors.warning }]}>
          {onDownload ? 'Finish download' : 'Partly downloaded'}
        </Text>
      </TouchableOpacity>
    )
  }

  if (!onDownload) return null

  return (
    <TouchableOpacity
      style={styles.row}
      onPress={onDownload}
      accessibilityRole="button"
      accessibilityLabel="Download for offline reading"
    >
      <Ionicons name="cloud-download-outline" size={13} color={colors.textSecondary} />
      <Text style={[styles.text, { color: colors.textSecondary }]}>Download</Text>
    </TouchableOpacity>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 4 },
  text: { fontSize: 11, fontFamily: fonts.sansMedium },
})
