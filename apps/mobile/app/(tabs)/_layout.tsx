import { useEffect, useRef } from 'react'
import { Redirect, Tabs } from 'expo-router'
import { Platform, Animated } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Ionicons } from '@expo/vector-icons'
import { useTheme } from '../../src/context/ThemeContext'
import { useLanguage } from '../../src/context/LanguageContext'
import { useAuth } from '../../src/context/AuthContext'
import { useNativeLanguage } from '../../src/context/NativeLanguageContext'
import { languageOnboardingDecision } from '../../src/lib/languageOnboarding'
import { capabilitiesFor } from '../../src/lib/capabilities'
import { breadcrumb } from '../../src/lib/breadcrumb'
import { typography } from '../../src/theme/typography'
import { UploadTabButton } from '../../src/components/UploadTabButton'

function AnimatedTabIcon({ name, size, color, focused }: {
  name: keyof typeof Ionicons.glyphMap; size: number; color: string; focused: boolean
}) {
  const scale = useRef(new Animated.Value(1)).current
  useEffect(() => {
    if (focused) {
      Animated.sequence([
        Animated.spring(scale, { toValue: 1.15, useNativeDriver: true, tension: 100, friction: 8 }),
        Animated.spring(scale, { toValue: 1, useNativeDriver: true, tension: 80, friction: 10 }),
      ]).start()
    }
  }, [focused])
  return (
    <Animated.View style={{ transform: [{ scale }] }}>
      <Ionicons name={name} size={size} color={color} />
    </Animated.View>
  )
}

const TAB_ICONS: Record<string, { active: keyof typeof Ionicons.glyphMap; inactive: keyof typeof Ionicons.glyphMap }> = {
  Home:       { active: 'home', inactive: 'home-outline' },
  Discover:   { active: 'compass', inactive: 'compass-outline' },
  Library:    { active: 'library', inactive: 'library-outline' },
  Vocabulary: { active: 'school', inactive: 'school-outline' },
  Profile:    { active: 'person', inactive: 'person-outline' },
}

export default function TabLayout() {
  const { colors } = useTheme()
  const { t } = useLanguage()
  const { isAuthenticated, user } = useAuth()
  const { hasConfirmedLanguage } = useNativeLanguage()
  const insets = useSafeAreaInsets()

  // Asking which language the reader knows. This decision used to live in a
  // null-rendering component beside the root <Stack>, inside a useEffect with
  // two early returns — and it failed on device three times running, always the
  // same way: the question never appeared after registration and did appear on
  // the next cold start. Three fix attempts moved the mechanism around without
  // ever proving what the mechanism was, because the logging that was supposed
  // to settle it sat behind __DEV__ and the reproductions ran release builds.
  //
  // So the shape changes instead of the guess. A decision taken during render
  // cannot be missed: it is re-evaluated on every render of a screen the reader
  // is actually looking at, rather than once per change of an effect's
  // dependency list. The `alreadyOnboarding` guard the old version needed is
  // structural now — the onboarding route lives outside the tabs, so this
  // layout is not mounted while it is showing.
  const languageDecision = languageOnboardingDecision({
    serverNativeLanguage: user?.nativeLanguage,
    hasConfirmedLanguage,
  })
  // Who the question may be put to by THROWING THEM OUT OF WHERE THEY ARE.
  //
  // `languageOnboardingDecision` no longer knows about guests — a guest can
  // answer and the answer reaches the server, so "does this reader need to be
  // asked" is true for them. It does not follow that this is the place to ask.
  // The route below is full-screen with `gestureEnabled: false`; after guest
  // sessions every install starts as a guest, so leaving the redirect ungated
  // would put a modal question in front of every first launch — the cold-start
  // interruption this product is built to remove.
  //
  // A full account keeps the full screen (the flow QA signed off on). Everyone
  // else is asked in place, at the first word they long-press, by
  // `TranslationSheet` — where the answer produces the translation they asked
  // for instead of a detour.
  const caps = capabilitiesFor(user)
  const mayInterrupt = caps.isAccount

  // Survives a release build, unlike the console.log it replaces. If this
  // defect outlives the change, the next reproduction finally leaves a trace.
  breadcrumb('onboarding.decision', {
    decision: languageDecision,
    mayInterrupt,
    isAuthenticated,
    isGuest: caps.isGuest,
    serverLang: user?.nativeLanguage ?? null,
    confirmed: hasConfirmedLanguage,
  })

  // 'unknown' means storage has not answered yet. Rendering the tabs is the
  // right thing to do while waiting — the reader sees their library, and the
  // redirect happens the moment the answer arrives.
  if (languageDecision === 'ask' && mayInterrupt) return <Redirect href="/onboarding/language" />

  // On iOS the old hardcoded 88 already approximated the home-indicator
  // safe area. On Android the 60 didn't account for 3-button nav bars or
  // gesture bars, so icons overlapped the system UI (B-13). Use real
  // insets on both platforms — iOS keeps parity, Android gains padding.
  const baseHeight = Platform.OS === 'ios' ? 52 : 56
  const tabBarHeight = baseHeight + insets.bottom

  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: {
          borderTopWidth: 1,
          borderTopColor: colors.border,
          backgroundColor: colors.background,
          paddingTop: 4,
          paddingBottom: insets.bottom,
          height: tabBarHeight,
        },
        tabBarLabelStyle: typography.tabLabel,
        headerShown: true,
        headerStyle: { backgroundColor: colors.background },
        headerTitleStyle: { ...typography.h3, color: colors.text },
        headerShadowVisible: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          // Not a tab any more — a redirect that keeps `/` resolving for the
          // resume-from-background reset and the deep-link fallback.
          href: null,
          headerShown: false,
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: t('nav.library'),
          tabBarIcon: ({ focused, color }) => (
            <AnimatedTabIcon name={focused ? TAB_ICONS.Library.active : TAB_ICONS.Library.inactive} size={22} color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="search"
        options={{
          title: t('nav.discover'),
          tabBarIcon: ({ focused, color }) => (
            <AnimatedTabIcon name={focused ? TAB_ICONS.Discover.active : TAB_ICONS.Discover.inactive} size={22} color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="upload"
        options={{
          title: '',
          // Expo Router rejects href + tabBarButton together. Accounts get the
          // custom "+" button (it owns navigation via router.push); everyone
          // else gets the tab hidden via href: null.
          //
          // `canUpload`, not `isAuthenticated`: since the 2026-09-06 reversal
          // (ADR-014 §3) those two agree for a guest — a guest HAS a session and
          // the `Guest` entitlement tier grants one book at 50 MB — but they part
          // company for an install with no session at all, which is the case this
          // predicate still hides the "+" from. Keep reading the capability, not
          // the auth flag: the next capability to move across that line will move
          // in `lib/capabilities.ts` and nowhere else.
          ...(caps.canUpload
            ? { tabBarButton: () => <UploadTabButton /> }
            : { href: null }),
        }}
      />
      <Tabs.Screen
        name="vocabulary"
        options={{
          title: t('nav.vocabulary'),
          tabBarIcon: ({ focused, color }) => (
            <AnimatedTabIcon name={focused ? TAB_ICONS.Vocabulary.active : TAB_ICONS.Vocabulary.inactive} size={22} color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: t('nav.profile'),
          // Was hidden and reached from the Home header's avatar. Home is now a
          // redirect with no header, so hiding it would strand every setting,
          // sign-out and account-deletion behind nothing.
          tabBarIcon: ({ focused, color }) => (
            <AnimatedTabIcon name={focused ? TAB_ICONS.Profile.active : TAB_ICONS.Profile.inactive} size={22} color={color} focused={focused} />
          ),
        }}
      />
    </Tabs>
  )
}
