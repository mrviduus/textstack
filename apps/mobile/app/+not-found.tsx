import { useEffect } from 'react'
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native'
import { useRouter, usePathname, Stack } from 'expo-router'
import { colors } from '../src/theme/colors'

/**
 * Handles deep links from textstack.app web URLs.
 * Maps web URL patterns to mobile routes:
 *   /{lang}/vocabulary              → /vocabulary
 */
export default function NotFoundScreen() {
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (__DEV__) console.log('[+not-found] hit with pathname:', pathname)
    // Only run the web-URL → mobile-route remap when the incoming path
    // actually starts with a language prefix (`/en/...` or `/uk/...`).
    // Without this guard, a cold-start landing on a transient state path
    // could match the looser patterns below and yank the user out of home
    // into the reader (the "app opens on random screens" symptom).
    if (!/^\/(en|uk)\//.test(pathname)) return

    if (/^\/(en|uk)\/vocabulary/.test(pathname)) router.replace('/vocabulary')
  }, [pathname, router])

  return (
    <>
      <Stack.Screen options={{ title: 'Not Found', headerShown: true }} />
      <View style={styles.center}>
        <Text style={styles.title}>Page not found</Text>
        <TouchableOpacity
          style={styles.btn}
          onPress={() => router.replace('/')}
          accessibilityRole="button"
          accessibilityLabel="Go to home screen"
        >
          <Text style={styles.btnText}>Go Home</Text>
        </TouchableOpacity>
      </View>
    </>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background, padding: 20 },
  title: { fontSize: 18, fontWeight: '600', color: colors.text, marginBottom: 16 },
  btn: {
    backgroundColor: colors.primary,
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 8,
  },
  btnText: { color: '#fff', fontSize: 15, fontWeight: '600' },
})
