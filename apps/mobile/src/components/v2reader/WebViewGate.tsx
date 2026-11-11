import { useEffect, useState, type ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { WebView } from 'react-native-webview'
import { useTheme } from '../../context/ThemeContext'
import { useLanguage } from '../../context/LanguageContext'
import { openPlayStorePage } from '../../lib/playStore'
import { WEBVIEW_PACKAGE, WEBVIEW_PROBE_DEADLINE_MS, WEBVIEW_PROBE_HTML, webViewGate, type WebViewGate as Gate } from '../../lib/v2reader/webViewVersion'

/** A WebView found new enough stays so for the process (an update restarts the app's WebView anyway). */
let knownOk = false

/**
 * Asks the Android System WebView its version (an ES5 probe document) before the V2 reader page loads (#1228):
 * older than the floor, the "update your WebView" screen instead of the reader; unknown, the reader (`unknown`
 * tells it so, for its `ready` deadline message).
 */
export function WebViewGate({ children }: { children: (unknown: boolean) => ReactNode }) {
  const [gate, setGate] = useState<Gate | null>(knownOk ? 'ok' : null)
  const [probe, setProbe] = useState(0)
  const decide = (g: Gate) => {
    knownOk ||= g === 'ok'
    setGate((now) => now ?? g)
  }

  useEffect(() => {
    if (gate) return
    const timer = setTimeout(() => decide('unknown'), WEBVIEW_PROBE_DEADLINE_MS)
    return () => clearTimeout(timer)
  }, [gate, probe])

  if (gate === 'ok' || gate === 'unknown') return children(gate === 'unknown')
  if (gate === 'update') return <UpdateWebView onRetry={() => { setGate(null); setProbe((p) => p + 1) }} />
  return (
    <View style={styles.probe} pointerEvents="none">
      <WebView
        key={probe}
        source={{ html: WEBVIEW_PROBE_HTML }}
        onMessage={(e) => decide(webViewGate(e.nativeEvent.data))}
      />
    </View>
  )
}

function UpdateWebView({ onRetry }: { onRetry: () => void }) {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const button = [styles.button, { backgroundColor: colors.primary }]
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: colors.background }]}>
      <View accessibilityRole="alert" style={styles.body}>
        <Text style={[styles.title, { color: colors.text }]}>{t('updates.webView.title')}</Text>
        <Text style={[styles.text, { color: colors.textSecondary }]}>{t('updates.webView.body')}</Text>
      </View>
      <Pressable onPress={() => openPlayStorePage(WEBVIEW_PACKAGE)} accessibilityRole="button" style={button}>
        <Text style={styles.buttonText}>{t('updates.webView.cta')}</Text>
      </Pressable>
      <Pressable onPress={onRetry} accessibilityRole="button" style={styles.retry}>
        <Text style={[styles.retryText, { color: colors.primary }]}>{t('updates.webView.retry')}</Text>
      </Pressable>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  // Not 0×0: a WebView must have a size to be sure it lays out and runs its page.
  probe: { position: 'absolute', width: 1, height: 1, opacity: 0 },
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32, gap: 14 },
  body: { alignItems: 'center', gap: 14 },
  title: { fontSize: 20, fontWeight: '700', textAlign: 'center' },
  text: { fontSize: 15, lineHeight: 22, textAlign: 'center' },
  button: { marginTop: 8, paddingHorizontal: 28, paddingVertical: 12, borderRadius: 10 },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  retry: { paddingHorizontal: 16, paddingVertical: 10 },
  retryText: { fontSize: 15, fontWeight: '600' },
})
