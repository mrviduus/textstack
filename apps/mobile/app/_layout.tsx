import { useEffect, useRef } from 'react'
import { AppState, View } from 'react-native'
import { Stack, useRouter, usePathname } from 'expo-router'
import { trackAppResumedFromBackground } from '../src/lib/analytics'
import { StatusBar } from 'expo-status-bar'
import * as SplashScreen from 'expo-splash-screen'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
import { setupApi } from '../src/lib/api'
import { Sentry, initSentry } from '../src/lib/sentry'
import { AuthProvider, useAuth } from '../src/context/AuthContext'
import { DownloadProvider } from '../src/context/DownloadContext'
import { ThemeProvider, useTheme } from '../src/context/ThemeContext'
import { LanguageProvider } from '../src/context/LanguageContext'
import { NativeLanguageProvider } from '../src/context/NativeLanguageContext'
import { ToastProvider } from '../src/context/ToastContext'
import { ErrorBoundary } from '../src/components/ErrorBoundary'
import { LegacyRuntimeBanner } from '../src/components/LegacyRuntimeBanner'
import { AutoUpdater } from '../src/components/AutoUpdater'
import { useAppFonts } from '../src/theme/fonts'

SplashScreen.preventAutoHideAsync()

// Before anything else, so an error during provider setup is still reported.
// Completely inert without EXPO_PUBLIC_SENTRY_DSN.
initSentry()

setupApi()

// 30 min — after this much time in background, treat the next foreground
// as if the user re-opened the app cold and reset navigation to home.
// Shorter (e.g. 5 min) would yank users out of the reader if they answered
// a phone call; longer would let "yesterday's screen" feel like a cold
// launch landing in the middle of a book.
const COLD_RESET_THRESHOLD_MS = 30 * 60 * 1000

// Routes the reset-on-resume skips. Reading is a long-running activity
// users explicitly chose — Kindle / Apple Books resume the book even after
// days. Resetting only transient navigation (library/discover/stats/etc.)
// matches the "remember where I was reading, forget where I was browsing"
// mental model that drove the original "random screens" complaint.
const PROTECTED_ROUTE_PREFIXES = ['/reader/', '/my-books/read/']

/**
 * Background-on-resume navigation reset, isolated in its own component so
 * the `usePathname()` re-render scope is just this one View (renders null).
 * Putting it on `AppContent` would re-render the whole `<Stack>` tree on
 * every navigation — measurable jank in the reader's WebView mounts.
 *
 * Lifecycle:
 *   background → record timestamp in ref
 *   active     → if (now - timestamp) > threshold AND not in protected
 *                route → dismissAll() + replace('/')
 */
function ColdResetOnResume() {
  const router = useRouter()
  const pathname = usePathname()
  const backgroundedAtRef = useRef<number | null>(null)
  const pathnameRef = useRef(pathname)
  useEffect(() => { pathnameRef.current = pathname }, [pathname])

  useEffect(() => {
    const sub = AppState.addEventListener('change', state => {
      if (state === 'background' || state === 'inactive') {
        backgroundedAtRef.current = Date.now()
        return
      }
      if (state === 'active') {
        const since = backgroundedAtRef.current
        backgroundedAtRef.current = null
        if (since == null) return
        const backgroundedForMs = Date.now() - since
        const path = pathnameRef.current || ''
        // Only consider reset if past threshold. Short backgrounds
        // (notifications, brief context switches) get NO telemetry —
        // they're high-volume and uninteresting.
        if (backgroundedForMs <= COLD_RESET_THRESHOLD_MS) return

        const inProtectedRoute = PROTECTED_ROUTE_PREFIXES.some(p => path.startsWith(p))
        // Telemetry fires regardless of the decision — that's the point.
        // Dashboards need both reset and skip rows to compute "% of long
        // backgrounds where we kept the user in the reader".
        trackAppResumedFromBackground({
          backgroundedForMs,
          pathname: path,
          wasInProtectedRoute: inProtectedRoute,
          resetToHome: !inProtectedRoute,
        })

        if (inProtectedRoute) {
          // Skip — book sessions are intentional and resumeable. Resetting
          // here would feel like the app threw away the reader mid-chapter.
          if (__DEV__) console.log('[appstate] skip cold-reset, in protected route:', path)
          return
        }
        // Resetting to the home tab — users complained the app re-opened
        // on "random screens" (Expo Router preserves nav state across
        // warm starts, so a long background looked like a cold launch
        // landing in library/stats/discover). dismissAll() drops the
        // modal stack first; replace then lands on the tabs root.
        try { router.dismissAll() } catch {}
        router.replace('/')
      }
    })
    return () => sub.remove()
  }, [router])

  return null
}

/*
 * `LanguageOnboardingGate` used to live here: a null-rendering sibling of the
 * <Stack> that decided, inside a useEffect with two early returns, whether to
 * send a reader to the language question. It failed on device three times in a
 * row, always identically — no question after registration, the question on the
 * next cold start — and three fix attempts moved its internals around without
 * ever establishing why, because the logging meant to settle it sat behind
 * __DEV__ while every reproduction ran a release build.
 *
 * The decision now happens during render, in `app/(tabs)/_layout.tsx`, where the
 * reader actually lands. A render-time decision cannot be missed the way an
 * effect can. It also has to live inside a screen subtree: expo-router's
 * <Redirect> is built on useFocusEffect, which needs a navigation focus context
 * that a sibling of the navigator does not have.
 */

function AppContent() {
  const { isDark } = useTheme()

  return (
    // Wrapped rather than a fragment so LegacyRuntimeBanner can push the navigator
    // down instead of covering a screen's own header. It renders null on every
    // runtime except the frozen "1.0.0" one, so this costs an empty View.
    <View style={{ flex: 1 }}>
      <ColdResetOnResume />
      <StatusBar style={isDark ? 'light' : 'dark'} />
      <LegacyRuntimeBanner />
      <AutoUpdater />
      <View style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="(auth)/login" options={{ presentation: 'modal' }} />
          {/* Not a modal and not dismissible by gesture: it is a step, and the
              value it collects is the one the reader cannot use the app without. */}
          <Stack.Screen name="onboarding/language" options={{ animation: 'fade', gestureEnabled: false }} />
          <Stack.Screen name="book/[slug]" />
          <Stack.Screen name="reader/[bookSlug]/[chapterSlug]" options={{ animation: 'slide_from_bottom' }} />
          <Stack.Screen name="vocabulary/review" />
          <Stack.Screen name="stats/index" />
          <Stack.Screen name="author/[slug]" />
          <Stack.Screen name="genre/[slug]" />
          <Stack.Screen name="my-books/upload" options={{ presentation: 'modal' }} />
          <Stack.Screen name="my-books/[id]" />
          <Stack.Screen name="my-books/read/[bookId]/[chapterSlug]" options={{ animation: 'slide_from_bottom' }} />
          <Stack.Screen name="highlights/index" />
          <Stack.Screen name="highlights/review" />
          <Stack.Screen name="about" />
          <Stack.Screen name="privacy" />
          <Stack.Screen name="terms" />
          <Stack.Screen name="contact" />
        <Stack.Screen name="connect" />
          <Stack.Screen name="books" />
          <Stack.Screen name="authors" />
        </Stack>
      </View>
    </View>
  )
}

function RootLayout() {
  const [fontsLoaded, fontError] = useAppFonts()

  useEffect(() => {
    if (__DEV__) {
      console.log('[TextStack] RootLayout mounted, fontsLoaded:', fontsLoaded, 'fontError:', fontError)
    }
  }, [fontsLoaded, fontError])

  useEffect(() => {
    if (fontsLoaded || fontError) {
      if (__DEV__) {
        console.log('[TextStack] Hiding splash, fontsLoaded:', fontsLoaded, 'fontError:', fontError)
      }
      // Can reject with "No native splash screen registered" on some platforms
      // or if already hidden — swallow with a warn rather than crashing the UI.
      SplashScreen.hideAsync().catch(e => console.warn('Splash hide failed:', e))
    }
  }, [fontsLoaded, fontError])

  if (!fontsLoaded && !fontError) return null

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ErrorBoundary>
        <ThemeProvider>
          <LanguageProvider>
            <AuthProvider>
              {/* NativeLanguageProvider sits INSIDE AuthProvider so it can mirror
                  the signed-in user's nativeLanguage from the server (parity with
                  web). Outside it, mobile only ever saw the local default. */}
              <NativeLanguageProvider>
                <DownloadProvider>
                  <ToastProvider>
                    <AppContent />
                  </ToastProvider>
                </DownloadProvider>
              </NativeLanguageProvider>
            </AuthProvider>
          </LanguageProvider>
        </ThemeProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  )
}

// Sentry.wrap adds the touch/navigation breadcrumbs and native crash context that
// make a report readable. It is a pass-through when the SDK was never initialised.
export default Sentry.wrap(RootLayout)
