import type { ComponentProps } from 'react'
import { Text, TouchableOpacity, type StyleProp, type TextStyle, type ViewStyle } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../context/ThemeContext'

/**
 * The offline-download button on the book screen: the book's file on this device (DownloadContext).
 * Three states — on the device, downloading, else Download. Each screen passes its own button/text style.
 */
export function DownloadButton({
  cached, downloading, onStart, startLabel = 'Download for Offline',
  buttonStyle, textStyle,
}: {
  cached: boolean
  downloading: boolean
  onStart: () => void
  startLabel?: string
  buttonStyle: StyleProp<ViewStyle>
  textStyle: StyleProp<TextStyle>
}) {
  const { colors } = useTheme()
  const button = (
    icon: ComponentProps<typeof Ionicons>['name'], border: string, color: string,
    label: string, a11y: string, onPress?: () => void,
  ) => (
    <TouchableOpacity
      style={[buttonStyle, { borderColor: border }]}
      onPress={onPress}
      disabled={!onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel={a11y}
    >
      <Ionicons name={icon} size={18} color={color} />
      <Text style={[textStyle, { color }]}>{label}</Text>
    </TouchableOpacity>
  )

  if (cached) return button('cloud-done-outline', colors.success, colors.success, 'On this device', 'Available offline')
  if (downloading) return button('cloud-download-outline', colors.primary, colors.primary, 'Downloading…', 'Downloading')
  return button('download-outline', colors.border, colors.text, startLabel, 'Download for offline reading', onStart)
}
