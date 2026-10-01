import type { ComponentProps } from 'react'
import { Text, TouchableOpacity, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { plural } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import type { DownloadInfo } from '../../context/DownloadContext'

/**
 * The offline-download button on both book screens (catalog + upload): one
 * download engine (DownloadContext), so one four-state button —
 * cached → Remove, downloading → Cancel %, failed chapters → Retry, else Download.
 * Each screen passes its own button/text style.
 */
export function DownloadButton({
  dl, cached, onRemove, onCancel, onRetry, onStart, onRestart, startLabel = 'Download for Offline',
  buttonStyle, textStyle,
}: {
  dl: DownloadInfo | undefined
  cached: boolean
  onRemove: () => void
  onCancel: () => void
  onRetry: () => void
  onStart: () => void
  /** Error state only: a second "Re-download from scratch" button. */
  onRestart?: () => void
  startLabel?: string
  buttonStyle: StyleProp<ViewStyle>
  textStyle: StyleProp<TextStyle>
}) {
  const { colors } = useTheme()
  const button = (
    icon: ComponentProps<typeof Ionicons>['name'], border: string, color: string,
    label: string, a11y: string, onPress: () => void,
  ) => (
    <TouchableOpacity
      style={[buttonStyle, { borderColor: border }]}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={a11y}
    >
      <Ionicons name={icon} size={18} color={color} />
      <Text style={[textStyle, { color }]}>{label}</Text>
    </TouchableOpacity>
  )

  if (cached) {
    return button('cloud-done-outline', colors.success, colors.success, 'Downloaded — Remove', 'Remove offline download', onRemove)
  }
  if (dl?.status === 'downloading') {
    const pct = dl.totalChapters > 0 ? Math.round((dl.downloadedChapters / dl.totalChapters) * 100) : 0
    return button('cloud-download-outline', colors.primary, colors.primary, `Downloading ${pct}% — Cancel`, 'Cancel download', onCancel)
  }
  if (dl?.status === 'error' && dl.failedChapters > 0) {
    return (
      <>
        {button('refresh', colors.warning, colors.warning,
          plural(dl.failedChapters, 'chapter', 'chapters', 'Retry {n} failed {noun}'), 'Retry failed chapters', onRetry)}
        {onRestart && button('refresh-circle-outline', colors.border, colors.text,
          'Re-download from scratch', 'Re-download from scratch', onRestart)}
      </>
    )
  }
  return button('download-outline', colors.border, colors.text, startLabel, 'Download for offline reading', onStart)
}
