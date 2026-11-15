import { useCallback, useEffect, useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { useRouter } from 'expo-router'
import { vocabularyApi } from '@textstack/shared'
import type { WordClusterDto } from '@textstack/shared'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { fonts } from '../../theme/typography'
import { fill } from '../../lib/fill'

interface Props {
  onChange?: () => void
}

export function ClusterBonusCard({ onChange }: Props) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const router = useRouter()
  const [cluster, setCluster] = useState<WordClusterDto | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const resp = await vocabularyApi.getClusters()
      setCluster(resp.items[0] ?? null)
    } catch {
      setCluster(null)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  if (!cluster) return null

  const handleStart = () => {
    router.push(`/vocabulary/review?cluster=${cluster.id}&reviewMode=blitz` as never)
  }

  const handleDismiss = async () => {
    setBusy(true)
    try {
      await vocabularyApi.dismissCluster(cluster.id)
      setCluster(null)
      onChange?.()
    } finally {
      setBusy(false)
    }
  }

  const subtitle = cluster.bookTitle
    ? fill(t('vocabulary.clusters.fromBook'), { book: cluster.bookTitle })
    : null

  return (
    <View style={[styles.card, { borderColor: colors.border }]}>
      <View style={styles.body}>
        <Text style={styles.icon}>✨</Text>
        <View style={styles.text}>
          <Text style={[styles.title, { color: colors.text, fontFamily: fonts.sansMedium }]} numberOfLines={2}>
            {cluster.title}
          </Text>
          <Text style={[styles.meta, { color: colors.textSecondary, fontFamily: fonts.sans }]} numberOfLines={1}>
            {fill(t('vocabulary.clusters.bonusCta'), { n: cluster.memberCount })}
            {subtitle ? ` · ${subtitle}` : ''}
          </Text>
        </View>
      </View>
      <View style={styles.actions}>
        <TouchableOpacity
          disabled={busy}
          style={[styles.startBtn, { backgroundColor: colors.primary }]}
          onPress={handleStart}
        >
          <Text style={[styles.startText, { fontFamily: fonts.sansMedium }]}>
            {t('vocabulary.clusters.start')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          disabled={busy}
          style={[styles.dismissBtn, { borderColor: colors.border }]}
          onPress={handleDismiss}
        >
          <Text style={[styles.dismissText, { color: colors.textSecondary, fontFamily: fonts.sans }]}>
            {t('common.dismiss')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    backgroundColor: '#fff8e1',
  },
  body: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  icon: { fontSize: 24 },
  text: { flex: 1, gap: 2 },
  title: { fontSize: 15, lineHeight: 20 },
  meta: { fontSize: 12, lineHeight: 16 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  startBtn: { flex: 1, paddingVertical: 10, borderRadius: 8, alignItems: 'center' },
  startText: { color: '#fff', fontSize: 14 },
  dismissBtn: { paddingVertical: 10, paddingHorizontal: 14, borderRadius: 8, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  dismissText: { fontSize: 13 },
})
