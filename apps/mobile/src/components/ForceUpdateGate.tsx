import { useEffect, useRef, useState } from 'react'
import { AppState, Platform, StyleSheet, Text, TouchableOpacity, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import * as Application from 'expo-application'
import { publicFetch } from '@textstack/shared'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../context/ThemeContext'
import { useLanguage } from '../context/LanguageContext'
import { fonts } from '../theme/typography'
import { usePathname } from 'expo-router'
import * as Updates from 'expo-updates'
import { buildGate, isCheckDue, nudgeVisible, type BuildGate } from '../lib/appVersion'
import { isLegacyRuntime } from '../lib/legacyRuntime'
import { isReading } from '../lib/updateApply'
import { openPlayStore } from '../lib/playStore'

// Android only: the button goes to Google Play, and there is no iOS listing to send anyone to.
const ENABLED = Platform.OS === 'android'
// versionCode, not the version name — every build reports "1.0.0" (see lib/appVersion).
const CURRENT_BUILD = Application.nativeBuildVersion

/**
 * Below the server's `Mobile:LatestBuild` (but supported) it shows a dismissible "new version" bar instead.
 *
 * Covers the whole app with "Please update TextStack" when this build number is below
 * the server's `Mobile:MinSupportedBuild` (`GET /app/config`). Checked at start and
 * on foreground at most once a day.
 *
 * Never blocks on the network: the app renders underneath from the first frame, and
 * the cover appears only after a successful answer says so. Offline, a failed fetch,
 * no minimum or an unparsable one — all leave the app alone.
 */
export function ForceUpdateGate() {
  const [gate, setGate] = useState<BuildGate>('ok')
  const [latest, setLatest] = useState<number | null>(null)
  const [dismissedFor, setDismissedFor] = useState<number | null>(null)
  const pathname = usePathname()
  const lastCheckedAt = useRef<number | null>(null)

  useEffect(() => {
    if (!ENABLED) return
    const check = () => {
      const now = Date.now()
      if (!isCheckDue(lastCheckedAt.current, now)) return
      lastCheckedAt.current = now
      publicFetch<{ minSupportedBuild?: number | null; latestBuild?: number | null }>('/app/config')
        .then(cfg => {
          setGate(buildGate(CURRENT_BUILD, cfg))
          setLatest(cfg.latestBuild ?? null)
        })
        .catch(() => { lastCheckedAt.current = null }) // retry on the next foreground
    }
    check()
    const sub = AppState.addEventListener('change', s => { if (s === 'active') check() })
    return () => sub.remove()
  }, [])

  if (gate === 'blocked') return <ForceUpdateScreen />
  if (nudgeVisible({
    gate, latest, dismissedFor,
    reading: isReading(pathname),
    legacyBanner: isLegacyRuntime(Updates.runtimeVersion, Updates.isEnabled, Platform.OS),
  })) return <NewBuildBar onDismiss={() => setDismissedFor(latest)} />
  return null
}

/** A newer build exists on Play: say so, but never over the reader (see `nudgeVisible`). */
function NewBuildBar({ onDismiss }: { onDismiss: () => void }) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const insets = useSafeAreaInsets()
  return (
    <View
      style={[styles.bar, { top: insets.top + 8, backgroundColor: colors.surface, borderColor: colors.border }]}
      accessibilityRole="alert"
    >
      <Text style={[styles.barText, { color: colors.text }]} numberOfLines={2}>{t('updates.newBuild.text')}</Text>
      <TouchableOpacity onPress={openPlayStore} hitSlop={12} accessibilityRole="button">
        <Text style={[styles.barCta, { color: colors.primary }]}>{t('updates.newBuild.cta')}</Text>
      </TouchableOpacity>
      <TouchableOpacity onPress={onDismiss} hitSlop={12} accessibilityRole="button" accessibilityLabel={t('updates.newBuild.dismiss')}>
        <Ionicons name="close" size={18} color={colors.textSecondary} />
      </TouchableOpacity>
    </View>
  )
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
  bar: {
    position: 'absolute', left: 12, right: 12, zIndex: 900, elevation: 900,
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, borderWidth: 1,
  },
  barText: { flex: 1, fontFamily: fonts.sans, fontSize: 13 },
  barCta: { flexShrink: 0, fontFamily: fonts.sansBold, fontSize: 14 },
  wrap: { alignItems: 'center', justifyContent: 'center', padding: 32, gap: 14, zIndex: 1000, elevation: 1000 },
  title: { fontFamily: fonts.sansBold, fontSize: 20, textAlign: 'center' },
  body: { fontFamily: fonts.sans, fontSize: 15, lineHeight: 22, textAlign: 'center' },
  cta: { marginTop: 8, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 10 },
  ctaText: { color: '#FFFFFF', fontFamily: fonts.sansBold, fontSize: 16 },
})
