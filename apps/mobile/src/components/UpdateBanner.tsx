import { useEffect, useRef, useSyncExternalStore } from 'react'
import { Animated, Easing, Platform, StyleSheet, Text, View } from 'react-native'
import { usePathname } from 'expo-router'
import * as Updates from 'expo-updates'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../context/ThemeContext'
import { useLanguage } from '../context/LanguageContext'
import { useToast } from '../context/ToastContext'
import { fonts } from '../theme/typography'
import { restartStore, shouldAnnounceUpdate, updateBannerState } from '../lib/updateBanner'

const LAST_SEEN_KEY = 'updates.lastSeenId'
// Metro build, web, or a build without expo-updates: no OTA can exist.
const NO_UPDATES = __DEV__ || Platform.OS === 'web' || !Updates.isEnabled

/**
 * Makes AutoUpdater's work visible. Overlay, not a layout row: pushing the
 * navigator down mid-screen would be a worse jolt than the one it explains.
 * pointerEvents="none" so it never eats a tap on the header beneath it.
 *
 * In the reader, "ready" is a one-off toast rather than a bar — the toast sits
 * above the footer, goes away on its own, and never pins anything over text.
 */
export function UpdateBanner() {
  if (NO_UPDATES) return null
  return <UpdateBannerInner />
}

function UpdateBannerInner() {
  const { isDownloading, downloadProgress, isUpdatePending } = Updates.useUpdates()
  const pathname = usePathname()
  const restarting = useSyncExternalStore(restartStore.subscribe, restartStore.get)
  const insets = useSafeAreaInsets()
  const { colors } = useTheme()
  const { t } = useLanguage()
  const { show } = useToast()

  const state = updateBannerState({
    isDev: false, isDownloading, downloadProgress, isUpdatePending, pathname, restarting,
  })

  // After a restart: say it worked. First run stores silently.
  useEffect(() => {
    const current = Updates.updateId
    AsyncStorage.getItem(LAST_SEEN_KEY).then(last => {
      if (shouldAnnounceUpdate(last, current, Updates.isEmbeddedLaunch, false)) {
        show({ message: t('updates.updated'), variant: 'success' })
      }
      if (!Updates.isEmbeddedLaunch && current && current !== last) {
        return AsyncStorage.setItem(LAST_SEEN_KEY, current)
      }
    }).catch(() => {})
    // Once per launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Once per entry into the state, not on every re-render while it holds.
  const toldReader = useRef(false)
  useEffect(() => {
    if (state.kind !== 'ready-in-reader') { toldReader.current = false; return }
    if (toldReader.current) return
    toldReader.current = true
    show({ message: t('updates.readyInReader'), variant: 'info', icon: 'arrow-up-circle-outline', duration: 4000 })
  }, [state.kind, show, t])

  const pulse = useRef(new Animated.Value(0.35)).current
  const indeterminate = state.kind === 'downloading' && state.progress === undefined
  useEffect(() => {
    if (!indeterminate) return
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0.35, duration: 700, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]))
    loop.start()
    return () => loop.stop()
  }, [indeterminate, pulse])

  if (state.kind !== 'downloading' && state.kind !== 'restarting') return null

  const label = state.kind === 'restarting' ? t('updates.restarting') : t('updates.downloading')
  const progress = state.kind === 'downloading' ? state.progress : 1

  return (
    <View pointerEvents="none" style={[styles.wrap, { paddingTop: insets.top }]}>
      <View
        style={[styles.bar, { backgroundColor: colors.surface, borderBottomColor: colors.border }]}
        accessibilityLiveRegion="polite"
        accessibilityRole="progressbar"
        accessibilityLabel={label}
        accessibilityValue={progress === undefined ? undefined : { min: 0, max: 100, now: Math.round(progress * 100) }}
      >
        <Text style={[styles.text, { color: colors.text }]} numberOfLines={1}>{label}</Text>
        <View style={[styles.track, { backgroundColor: colors.border }]}>
          {progress === undefined ? (
            <Animated.View style={[styles.fill, { width: '100%', backgroundColor: colors.primary, opacity: pulse }]} />
          ) : (
            <View style={[styles.fill, { width: `${progress * 100}%`, backgroundColor: colors.primary }]} />
          )}
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1000, elevation: 1000 },
  bar: {
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 6,
    gap: 5,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  text: { fontFamily: fonts.sansMedium, fontSize: 12 },
  track: { height: 3, borderRadius: 2, overflow: 'hidden' },
  fill: { height: 3, borderRadius: 2 },
})
