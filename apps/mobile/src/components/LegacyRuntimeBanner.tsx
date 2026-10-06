import { useState } from 'react'
import { View, Text, TouchableOpacity, StyleSheet, Platform } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import * as Updates from 'expo-updates'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTheme } from '../context/ThemeContext'
import { fonts } from '../theme/typography'
import { isLegacyRuntime } from '../lib/legacyRuntime'
import { openPlayStore } from '../lib/playStore'

/**
 * Tells users stuck on the legacy `1.0.0` runtime that their build no longer
 * receives over-the-air updates and that the fix is a Play Store install.
 *
 * Background. `app.json` used `runtimeVersion.policy: "appVersion"`, which resolved
 * to the literal string "1.0.0", while `eas.json` `autoIncrement` only ever bumped
 * `versionCode`. So every native build shared one runtime, and any OTA published to
 * it could land on a binary missing the native modules that update needed. The
 * defensive `try { require(...) } catch {}` guards in useTts.ts, vocabReminder.ts and
 * profile.tsx are that hazard already happening, degrading features in silence.
 *
 * The fix is `runtimeVersion.policy: "fingerprint"`, which hashes the native inputs
 * so adding a native dependency changes the runtime by construction. But switching
 * has a cost that cannot be avoided, only made visible: once the policy changes, no
 * future `eas update` can ever target "1.0.0" again, so anyone still on an old binary
 * silently stops receiving updates forever.
 *
 * This banner is the last thing published to "1.0.0" before that switch — a farewell
 * OTA. It converts an invisible freeze into an actionable prompt.
 *
 * SHIPPING ORDER MATTERS. Publish this to the old runtime BEFORE the policy change
 * merges:
 *
 *   npx eas update --branch production --platform android \
 *     --message "Update available from Play Store"
 *
 * Self-disabling by design: builds made after the switch carry a fingerprint hash as
 * their runtime, never the string "1.0.0", so this renders null on them. It is safe
 * to leave in the tree and costs one string comparison at mount.
 *
 * A static import of expo-updates is safe here even though the codebase guards other
 * native modules defensively: an OTA is *delivered by* expo-updates, so any build that
 * can receive this code necessarily has it.
 */

export function LegacyRuntimeBanner() {
  const { colors } = useTheme()
  const insets = useSafeAreaInsets()
  // Session-scoped dismissal on purpose. The build really is frozen, so the prompt
  // should come back on the next cold start rather than being silenced for good.
  const [dismissed, setDismissed] = useState(false)

  if (dismissed) return null
  if (!isLegacyRuntime(Updates.runtimeVersion, Updates.isEnabled, Platform.OS)) return null

  return (
    <View
      style={[
        styles.bar,
        { paddingTop: insets.top + 10, backgroundColor: colors.primaryLight, borderBottomColor: colors.border },
      ]}
      accessibilityRole="alert"
    >
      <Ionicons name="arrow-up-circle-outline" size={20} color={colors.primary} />
      <View style={styles.textWrap}>
        <Text style={[styles.title, { color: colors.text }]}>Update available</Text>
        <Text style={[styles.body, { color: colors.textSecondary }]}>
          This version no longer receives updates. Install the latest from Google Play.
        </Text>
      </View>
      <TouchableOpacity
        onPress={openPlayStore}
        style={[styles.cta, { backgroundColor: colors.primary }]}
        accessibilityRole="button"
        accessibilityLabel="Open Google Play to update TextStack"
      >
        <Text style={styles.ctaText}>Update</Text>
      </TouchableOpacity>
      <TouchableOpacity
        onPress={() => setDismissed(true)}
        style={styles.close}
        accessibilityRole="button"
        accessibilityLabel="Dismiss update notice"
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Ionicons name="close" size={18} color={colors.textSecondary} />
      </TouchableOpacity>
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  textWrap: { flex: 1 },
  title: { fontFamily: fonts.sansBold, fontSize: 14 },
  body: { fontFamily: fonts.sans, fontSize: 12, marginTop: 1 },
  cta: { paddingHorizontal: 12, paddingVertical: 7, borderRadius: 8 },
  ctaText: { color: '#FFFFFF', fontFamily: fonts.sansBold, fontSize: 13 },
  close: { padding: 2 },
})
