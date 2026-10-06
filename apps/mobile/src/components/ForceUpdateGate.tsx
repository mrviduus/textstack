import { useEffect, useRef, useState } from 'react'
import { AppState, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import * as Application from 'expo-application'
import { publicFetch } from '@textstack/shared'
import { useTheme } from '../context/ThemeContext'
import { useLanguage } from '../context/LanguageContext'
import { fonts } from '../theme/typography'
import { isBelowMinimum, isCheckDue } from '../lib/appVersion'
import { openPlayStore } from '../lib/playStore'

// Android only: the button goes to Google Play, and there is no iOS listing to send anyone to.
const ENABLED = Platform.OS === 'android'
const CURRENT = Application.nativeApplicationVersion

/**
 * Covers the whole app with "Please update TextStack" when this build is older than
 * the server's `Mobile:MinSupportedVersion` (`GET /app/config`). Checked at start and
 * on foreground at most once a day.
 *
 * Never blocks on the network: the app renders underneath from the first frame, and
 * the cover appears only after a successful answer says so. Offline, a failed fetch,
 * no minimum or an unparsable one — all leave the app alone.
 */
export function ForceUpdateGate() {
  const [blocked, setBlocked] = useState(false)
  const lastCheckedAt = useRef<number | null>(null)

  useEffect(() => {
    if (!ENABLED) return
    const check = () => {
      const now = Date.now()
      if (!isCheckDue(lastCheckedAt.current, now)) return
      lastCheckedAt.current = now
      publicFetch<{ minSupportedVersion?: string | null }>('/app/config')
        .then(cfg => setBlocked(isBelowMinimum(CURRENT, cfg.minSupportedVersion)))
        .catch(() => { lastCheckedAt.current = null }) // retry on the next foreground
    }
    check()
    const sub = AppState.addEventListener('change', s => { if (s === 'active') check() })
    return () => sub.remove()
  }, [])

  if (!blocked) return null
  return <ForceUpdateScreen />
}

function ForceUpdateScreen() {
  const { colors } = useTheme()
  const { t } = useLanguage()
  return (
    <View style={[StyleSheet.absoluteFill, styles.wrap, { backgroundColor: colors.background }]} accessibilityViewIsModal>
      <Ionicons name="arrow-up-circle-outline" size={56} color={colors.primary} />
      <Text style={[styles.title, { color: colors.text }]}>{t('updates.forceUpdate.title')}</Text>
      <Text style={[styles.body, { color: colors.textSecondary }]}>{t('updates.forceUpdate.body')}</Text>
      <TouchableOpacity
        onPress={openPlayStore}
        style={[styles.cta, { backgroundColor: colors.primary }]}
        accessibilityRole="button"
      >
        <Text style={styles.ctaText}>{t('updates.forceUpdate.cta')}</Text>
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 14, zIndex: 1000, elevation: 1000 },
  title: { fontFamily: fonts.sansBold, fontSize: 20, textAlign: 'center' },
  body: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  cta: { marginTop: 8, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 10 },
  ctaText: { color: '#FFFFFF', fontFamily: fonts.sansBold, fontSize: 16 },
})
