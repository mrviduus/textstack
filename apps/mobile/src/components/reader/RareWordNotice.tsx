import { View, Text, TouchableOpacity, StyleSheet } from 'react-native'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { fonts } from '../../theme/typography'

interface Props {
  kind: 'lookup' | 'lookup_pending'
  tapsRemaining: number | null
  busy: boolean
  onAddAnyway: () => void
}

export function RareWordNotice({ kind, tapsRemaining, busy, onAddAnyway }: Props) {
  const { colors } = useTheme()
  const { t } = useLanguage()

  const title = kind === 'lookup_pending' && tapsRemaining != null && tapsRemaining > 0
    ? t('reader.vocab.tapAgainToStudy').replace('{n}', String(tapsRemaining))
    : t('reader.rareWordNotice.title')

  return (
    <View style={[styles.wrap, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[styles.title, { color: colors.text, fontFamily: fonts.sansMedium }]}>{title}</Text>
      <Text style={[styles.body, { color: colors.textSecondary, fontFamily: fonts.sans }]}>
        {t('reader.rareWordNotice.body')}
      </Text>
      <TouchableOpacity
        disabled={busy}
        style={[styles.cta, { backgroundColor: colors.primary, opacity: busy ? 0.6 : 1 }]}
        onPress={onAddAnyway}
      >
        <Text style={[styles.ctaText, { fontFamily: fonts.sansMedium }]}>
          {busy ? t('reader.rareWordNotice.ctaBusy') : t('reader.rareWordNotice.cta')}
        </Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: 8,
    padding: 12,
    borderRadius: 10,
    borderWidth: 1,
  },
  title: { fontSize: 13, marginBottom: 4 },
  body: { fontSize: 12, lineHeight: 16, marginBottom: 8 },
  cta: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
  },
  ctaText: { color: '#fff', fontSize: 13 },
})
