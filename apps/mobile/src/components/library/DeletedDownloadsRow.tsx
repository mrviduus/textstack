import { useEffect, useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native'
import { plural } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { useDownload } from '../../context/DownloadContext'
import { useToast } from '../../context/ToastContext'
import { fonts } from '../../theme/typography'
import { listStoredOriginalIds } from '../../lib/originalFileCache'
import { deletedStillOnDevice, listDeletedOnServer } from '../../lib/deletedOnServer'

interface Props {
  /** Books the Library lists right now: never counted as deleted. */
  listedIds: string[]
}

/**
 * Server-deleted uploads whose bytes are still on this device (#1193). The orphan sweep and the
 * book screen's 404 only mark them (#1164: bytes stay until the reader removes them); this row is
 * where the reader does, all at once. Device-only, so it works offline. Renders nothing at zero.
 */
export function DeletedDownloadsRow({ listedIds }: Props) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const { show: showToast } = useToast()
  const { cachedUserBooks, removeUserBookDownload } = useDownload()
  const [ids, setIds] = useState<string[]>([])
  const [removing, setRemoving] = useState(false)
  const listedKey = listedIds.join(',')

  // `cachedUserBooks` changes after the sweep marks and after every removal (refreshCachedBooks).
  useEffect(() => {
    let cancelled = false
    Promise.all([listDeletedOnServer(), listStoredOriginalIds()])
      .then(([marked, originals]) => {
        if (cancelled) return
        setIds(deletedStillOnDevice(marked, [...cachedUserBooks.map(b => b.bookId), ...originals], new Set(listedIds)))
      })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listedKey stands for listedIds
  }, [cachedUserBooks, listedKey])

  if (ids.length === 0) return null

  const summary = plural(ids.length, 'deleted book', 'deleted books', t('library.deletedOnDevice.summary'))

  const remove = async () => {
    if (removing) return
    setRemoving(true)
    try {
      // The not-found screen's Remove, per book: rows, original, mark, cached lists.
      for (const id of ids) await removeUserBookDownload(id)
    } catch (err) {
      console.warn('Removing deleted books from the device failed:', err)
      showToast({ message: t('library.deletedOnDevice.failed'), variant: 'error', duration: 2600 })
    } finally {
      setRemoving(false)
    }
  }

  const confirm = () => Alert.alert(t('library.deletedOnDevice.confirmTitle'), t('library.deletedOnDevice.confirmBody'), [
    { text: t('common.cancel'), style: 'cancel' },
    { text: t('library.deletedOnDevice.remove'), style: 'destructive', onPress: () => { void remove() } },
  ])

  return (
    <View style={[styles.row, { borderColor: colors.border }]}>
      <Text style={[styles.label, { color: colors.textSecondary }]}>{summary}</Text>
      <TouchableOpacity
        onPress={confirm}
        disabled={removing}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={`${t('library.deletedOnDevice.remove')}: ${summary}`}
      >
        <Text style={[styles.action, { color: colors.primary, opacity: removing ? 0.6 : 1 }]}>
          {t('library.deletedOnDevice.remove')}
        </Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    paddingHorizontal: 14, paddingVertical: 12, marginTop: 8, borderTopWidth: StyleSheet.hairlineWidth,
  },
  label: { flex: 1, fontFamily: fonts.sans, fontSize: 13 },
  action: { fontFamily: fonts.sansMedium, fontSize: 14 },
})
