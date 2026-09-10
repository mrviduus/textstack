import { useCallback, useEffect, useState } from 'react'
import { ScrollView, View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native'
import { Stack, router } from 'expo-router'
import { Ionicons } from '@expo/vector-icons'
import * as Clipboard from 'expo-clipboard'
import {
  mcpKeysApi,
  claudeDesktopConfig,
  defaultKeyName,
  liveKeys,
  MCP_ENDPOINT,
  type McpKey,
  type CreatedMcpKey,
} from '@textstack/shared'
import { useTheme } from '../src/context/ThemeContext'
import { useLanguage } from '../src/context/LanguageContext'
import { useAuth } from '../src/context/AuthContext'
import { useToast } from '../src/context/ToastContext'
import { capabilitiesFor } from '../src/lib/capabilities'
import { EmptyState } from '../src/components/ui/EmptyState'
import { fonts } from '../src/theme/typography'

/**
 * Create and revoke the connect keys that let an outside assistant reach this reader's books.
 *
 * <p>The phone is where the reading happens, so it is where the key should be obtainable. The key is
 * account-level, so one minted here also works in Claude Desktop — which is why this screen is worth
 * having even if the mobile assistant apps turn out not to accept custom connectors.</p>
 *
 * <p>The key is shown once, in a panel that stays put. The server keeps only a SHA-256 of it, so
 * "copy it now" is a statement of fact rather than a nudge — a toast would take the value away with
 * it. The toast is used for the copy confirmation only.</p>
 */
export default function ConnectScreen() {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const { user } = useAuth()
  const { show: showToast } = useToast()
  const { canConnectAssistant } = capabilitiesFor(user)

  const [keys, setKeys] = useState<McpKey[]>([])
  const [loading, setLoading] = useState(false)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<CreatedMcpKey | null>(null)
  const [error, setError] = useState<string | null>(null)

  const screen = (
    <Stack.Screen options={{
      title: t('connect.title'),
      headerShown: true,
      headerStyle: { backgroundColor: colors.background },
      headerTintColor: colors.text,
      headerTitleStyle: { fontFamily: fonts.sansMedium, fontSize: 16 },
      headerShadowVisible: false,
    }} />
  )

  // Deliberately does not clear `error` on success: the mount refresh and a user action overlap, so a
  // create that failed at 200ms would have its message wiped by a list that succeeded at 300ms —
  // leaving a button that visibly did nothing. Each action clears the error it is about to replace.
  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      setKeys(await mcpKeysApi.listMcpKeys())
    } catch {
      setError(t('connect.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    if (canConnectAssistant) void refresh()
  }, [canConnectAssistant, refresh])

  if (!canConnectAssistant) {
    return (
      <>
        {screen}
        <View style={{ flex: 1, backgroundColor: colors.background }}>
          <EmptyState
            icon="key-outline"
            title={t('connect.signIn.title')}
            subtitle={t('connect.signIn.subtitle')}
            buttonLabel={t('connect.signIn.cta')}
            onButtonPress={() => router.push('/(auth)/login')}
          />
        </View>
      </>
    )
  }

  const create = async () => {
    setCreating(true)
    setError(null)
    try {
      const key = await mcpKeysApi.createMcpKey(defaultKeyName(new Date()))
      setCreated(key)
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : t('connect.createFailed'))
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (id: string) => {
    setError(null)
    try {
      await mcpKeysApi.revokeMcpKey(id)
      // A revoked key authenticates nothing; leaving it on screen invites pasting a dead string.
      if (created && created.id === id) setCreated(null)
      await refresh()
    } catch {
      setError(t('connect.revokeFailed'))
    }
  }

  const copy = async (text: string) => {
    await Clipboard.setStringAsync(text)
    // 12 rather than the default: this screen has no tab bar under it.
    showToast({ message: t('connect.copied'), variant: 'success', bottomOffset: 12 })
  }

  const live = liveKeys(keys)

  return (
    <>
      {screen}
      <ScrollView style={[styles.container, { backgroundColor: colors.background }]}>
        <Text style={[styles.lead, { color: colors.textSecondary }]}>{t('connect.lead')}</Text>

        {error && <Text style={[styles.error, { color: colors.error }]}>{error}</Text>}

        {created && (
          <View style={[styles.fresh, { borderColor: colors.primary, backgroundColor: colors.surface }]}>
            <Text style={[styles.once, { color: colors.text }]}>{t('connect.shownOnce')}</Text>

            <Text selectable style={[styles.key, { color: colors.text, backgroundColor: colors.background }]}>
              {created.key}
            </Text>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: colors.primary }]}
              onPress={() => copy(created.key)}
              accessibilityRole="button"
            >
              <Ionicons name="copy-outline" size={16} color="#fff" />
              <Text style={[styles.btnText, { color: '#fff' }]}>{t('connect.copyKey')}</Text>
            </TouchableOpacity>

            <Text style={[styles.configLabel, { color: colors.textSecondary }]}>{t('connect.configLabel')}</Text>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1 }]}
              onPress={() => copy(claudeDesktopConfig(created.key))}
              accessibilityRole="button"
            >
              <Ionicons name="copy-outline" size={16} color={colors.text} />
              <Text style={[styles.btnText, { color: colors.text }]}>{t('connect.copyConfig')}</Text>
            </TouchableOpacity>
          </View>
        )}

        <TouchableOpacity
          style={[styles.btn, styles.create, { backgroundColor: colors.primary, opacity: creating ? 0.6 : 1 }]}
          onPress={create}
          disabled={creating}
          accessibilityRole="button"
        >
          {creating
            ? <ActivityIndicator size="small" color="#fff" />
            : <Ionicons name="key-outline" size={16} color="#fff" />}
          <Text style={[styles.btnText, { color: '#fff' }]}>
            {creating ? t('connect.creating') : t('connect.createCta')}
          </Text>
        </TouchableOpacity>

        <Text style={[styles.endpointLabel, { color: colors.textSecondary }]}>{t('connect.endpointLabel')}</Text>
        <Text selectable style={[styles.endpoint, { color: colors.text, backgroundColor: colors.surface }]}>
          {MCP_ENDPOINT}
        </Text>

        {loading && live.length === 0 ? null : live.length === 0 ? (
          <Text style={[styles.empty, { color: colors.textSecondary }]}>{t('connect.empty')}</Text>
        ) : (
          live.map(k => (
            <View key={k.id} style={[styles.row, { borderBottomColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.rowName, { color: colors.text }]}>{k.name}</Text>
                <Text style={[styles.rowMeta, { color: colors.textSecondary }]}>
                  {k.prefix}… · {k.lastUsedAt ? t('connect.usedRecently') : t('connect.neverUsed')}
                </Text>
              </View>
              <TouchableOpacity onPress={() => revoke(k.id)} accessibilityRole="button">
                <Text style={[styles.revoke, { color: colors.error }]}>{t('connect.revoke')}</Text>
              </TouchableOpacity>
            </View>
          ))
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16 },
  lead: { fontSize: 14, lineHeight: 21, fontFamily: fonts.sans, marginBottom: 16 },
  error: { fontSize: 13, fontFamily: fonts.sans, marginBottom: 12 },
  fresh: { borderWidth: 1, borderRadius: 10, padding: 14, marginBottom: 16 },
  once: { fontSize: 13, fontFamily: fonts.sansMedium, marginBottom: 10, lineHeight: 19 },
  key: { fontSize: 12, fontFamily: 'Courier', padding: 10, borderRadius: 6, marginBottom: 10 },
  configLabel: { fontSize: 12, fontFamily: fonts.sans, marginTop: 14, marginBottom: 6 },
  btn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 11, paddingHorizontal: 16, borderRadius: 8,
  },
  btnText: { fontSize: 14, fontFamily: fonts.sansMedium },
  create: { marginBottom: 20 },
  endpointLabel: { fontSize: 12, fontFamily: fonts.sans, marginBottom: 6 },
  endpoint: { fontSize: 12, fontFamily: 'Courier', padding: 10, borderRadius: 6, marginBottom: 20 },
  empty: { fontSize: 13, fontFamily: fonts.sans },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, borderBottomWidth: 1 },
  rowName: { fontSize: 14, fontFamily: fonts.sansMedium },
  rowMeta: { fontSize: 12, fontFamily: fonts.sans, marginTop: 2 },
  revoke: { fontSize: 13, fontFamily: fonts.sansMedium },
})
