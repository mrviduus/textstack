import { useEffect, useState } from 'react'
import { View, Text, StyleSheet } from 'react-native'
import { userBooksApi } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { fonts } from '../../theme/typography'
import { formatBytes } from '../../lib/formatBytes'

export { formatBytes }

/**
 * How much upload space is left.
 *
 * This used to be an unlabelled bar sitting between the upload button and the
 * search box on the Library screen — a settings fact wedged into the middle of
 * a browsing surface, where a number nobody asked for competed with the books.
 * It belongs on Profile, and on Library only once it is about to matter.
 *
 * `variant="warning"` is the Library form: it renders nothing at all until the
 * store is nearly full, so the row appears exactly when it changes what the
 * reader would do next.
 */

/** Show the Library warning from this fill level up. */
export const QUOTA_WARN_AT = 0.8



interface Props {
  /** 'full' — always render (Profile). 'warning' — only when nearly full (Library). */
  variant?: 'full' | 'warning'
  /** Bump to refetch; the Library passes its book count so an upload or a
   *  delete moves the number without a manual pull-to-refresh. */
  refreshKey?: number
}

export function StorageQuotaRow({ variant = 'full', refreshKey = 0 }: Props) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const [quota, setQuota] = useState<{ usedBytes: number; limitBytes: number } | null>(null)

  useEffect(() => {
    let cancelled = false
    userBooksApi.getStorageQuota()
      .then(q => { if (!cancelled) setQuota(q) })
      .catch(e => console.warn('Storage quota fetch failed:', e))
    return () => { cancelled = true }
  }, [refreshKey])

  if (!quota || quota.limitBytes <= 0) return null

  const fraction = quota.usedBytes / quota.limitBytes
  if (variant === 'warning' && fraction < QUOTA_WARN_AT) return null

  const pct = Math.min(fraction * 100, 100)
  // Amber as it fills, red once there is effectively nothing left.
  const fill = fraction >= 0.95 ? colors.error : fraction >= QUOTA_WARN_AT ? colors.warning : colors.primary

  return (
    <View style={styles.wrap}>
      <View style={styles.labelRow}>
        <Text style={[styles.label, { color: colors.text }]}>{t('library.storage.label')}</Text>
        <Text style={[styles.value, { color: colors.textSecondary }]}>
          {formatBytes(quota.usedBytes)} / {formatBytes(quota.limitBytes)}
        </Text>
      </View>
      <View style={[styles.track, { backgroundColor: colors.textSecondary + '25' }]}>
        <View style={[styles.fill, { width: `${pct}%`, backgroundColor: fill }]} />
      </View>
      {fraction >= QUOTA_WARN_AT && (
        <Text style={[styles.warning, { color: fill }]}>{t('library.storage.nearlyFull')}</Text>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { paddingHorizontal: 14, paddingVertical: 12, gap: 6 },
  labelRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontFamily: fonts.sansMedium, fontSize: 14 },
  value: { fontFamily: fonts.sans, fontSize: 12 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 2 },
  warning: { fontFamily: fonts.sans, fontSize: 11 },
})
