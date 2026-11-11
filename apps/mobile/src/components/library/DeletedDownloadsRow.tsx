import { useCallback, useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native'
import { useFocusEffect } from 'expo-router'
import { plural } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { useDownload } from '../../context/DownloadContext'
import { useToast } from '../../context/ToastContext'
import { fonts } from '../../theme/typography'
import { listLocalLeftovers } from '../../lib/localLeftovers'
import { deletedStillOnDevice, listDeletedOnServer } from '../../lib/deletedOnServer'

interface Props {
  /** Books the Library lists right now: never counted as deleted. */
  listedIds: string[]
  /** Bumped by the Library when its load marked books deleted. */
  refreshKey: number
}

/**
 * Server-deleted uploads whose bytes are still on this device (#1193). Marking keeps the bytes
 * (#1164: they stay until the reader removes them); this row is where the reader does, all at once.
 * Device-only, so it works offline. Renders nothing at zero.
 */
export function DeletedDownloadsRow({ listedIds, refreshKey }: Props) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const { show: showToast } = useToast()
  const { cachedUserBooks, removeUserBookDownloads } = useDownload()
  const [ids, setIds] = useState<string[]>([])
  const [removing, setRemoving] = useState(false)
  const listedKey = listedIds.join(',')

  // On focus too: a mark the book screen's 404 wrote changes none of the deps.
  // `cachedUserBooks` changes after the sweep marks and after a removal (refreshCachedBooks).
  useFocusEffect(useCallback(() => {
    let cancelled = false
    Promise.all([listDeletedOnServer(), listLocalLeftovers()])
      .then(([marked, local]) => {
        if (!cancelled) setIds(deletedStillOnDevice(marked, local.keys(), new Set(listedIds)))
      })
      .catch(() => {})
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listedKey stands for listedIds
  }, [cachedUserBooks, listedKey, refreshKey]))

  if (ids.length === 0) return null

  const summary = plural(ids.length, t('library.deletedOnDevice.one'), t('library.deletedOnDevice.many'), t('library.deletedOnDevice.summary'))

  const remove = async () => {
    if (removing) return
    setRemoving(true)
    try {
      // The not-found screen's Remove for all of them, without declining (#1193); one refresh.
      const failed = await removeUserBookDownloads(ids, { decline: false })
      if (failed > 0) {
        showToast({
          message: plural(failed, t('library.deletedOnDevice.one'), t('library.deletedOnDevice.many'), t('library.deletedOnDevice.failed')),
          variant: 'error',
          duration: 2600,
        })
      }
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
