import { useCallback, useEffect, useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { useTheme } from '../../context/ThemeContext'
import { fonts } from '../../theme/typography'
import { formatBytes } from '../../lib/formatBytes'
import { clearTtsCache, measureDeviceStorage, type DeviceStorageReport } from '../../lib/deviceStorage'

/**
 * What the app is holding on THIS phone, as opposed to on the server.
 *
 * `StorageQuotaRow` above it answers a different question — how much of the
 * upload allowance is spent — and the two were easy to confuse while only one
 * existed. Downloaded books now take real space on the device, so the device
 * figure needs saying out loud. Kindle and Play Books both show it.
 *
 * Only speech gets a button. Removing a downloaded book is per-book and belongs
 * on the book, where the reader can see which one they are giving up; a single
 * "delete everything" here would be one tap away from throwing out a library
 * somebody is halfway through.
 */
export function DeviceStorageRow() {
  const { colors } = useTheme()
  const [report, setReport] = useState<DeviceStorageReport | null>(null)
  const [clearing, setClearing] = useState(false)

  const refresh = useCallback(() => {
    measureDeviceStorage().then(setReport).catch(() => setReport(null))
  }, [])

  useEffect(refresh, [refresh])

  // Nothing stored yet — a row reading "0 B" is noise on a fresh install.
  if (!report || report.totalBytes === 0) return null

  const onClear = async () => {
    if (clearing) return
    setClearing(true)
    try {
      await clearTtsCache()
      refresh()
    } finally {
      setClearing(false)
    }
  }

  return (
    <View style={[styles.row, { borderColor: colors.border }]}>
      <View style={styles.header}>
        <Text style={[styles.label, { color: colors.text }]}>On this device</Text>
        <Text style={[styles.total, { color: colors.text }]}>{formatBytes(report.totalBytes)}</Text>
      </View>

      <Text style={[styles.detail, { color: colors.textSecondary }]}>
        {`Books ${formatBytes(report.originalsBytes)}`}
        {report.ttsBytes > 0 ? ` · Speech ${formatBytes(report.ttsBytes)}` : ''}
      </Text>

      {report.ttsBytes > 0 && (
        <TouchableOpacity
          onPress={onClear}
          disabled={clearing}
          accessibilityRole="button"
          accessibilityLabel="Clear cached speech"
          style={styles.action}
        >
          <Text style={[styles.actionText, { color: colors.primary, opacity: clearing ? 0.6 : 1 }]}>
            {clearing ? 'Clearing…' : 'Clear cached speech'}
          </Text>
        </TouchableOpacity>
      )}

      <Text style={[styles.hint, { color: colors.textSecondary }]}>
        Remove a downloaded book from the book itself.
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: { borderWidth: 1, borderRadius: 12, padding: 16, marginBottom: 16 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  label: { fontSize: 15, fontFamily: fonts.sansMedium },
  total: { fontSize: 15, fontFamily: fonts.sansMedium },
  detail: { fontSize: 13, fontFamily: fonts.sans, marginTop: 6 },
  action: { marginTop: 12 },
  actionText: { fontSize: 14, fontFamily: fonts.sansMedium },
  hint: { fontSize: 12, fontFamily: fonts.sans, marginTop: 10 },
})
