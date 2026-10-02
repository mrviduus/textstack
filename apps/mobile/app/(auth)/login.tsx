import { useRef, useState } from 'react'
import {
  View, Text, StyleSheet, TouchableOpacity, ActivityIndicator,
  Alert, Platform, TextInput, KeyboardAvoidingView, ScrollView,
} from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { authApi, type UserDto } from '@textstack/shared'
import { GoogleSignin } from '@react-native-google-signin/google-signin'
import Constants from 'expo-constants'
import { useAuth } from '../../src/context/AuthContext'
import { capabilitiesFor } from '../../src/lib/capabilities'
import { useTheme } from '../../src/context/ThemeContext'
import { useToast } from '../../src/context/ToastContext'
import { useLanguage } from '../../src/context/LanguageContext'
import { fonts } from '../../src/theme/typography'

// Google OAuth Client IDs, sourced from app.json → expo.extra.googleAuth.
// Keeping them out of source makes it possible to ship different IDs per
// build profile (dev vs. prod) without editing code, and surfaces the
// configuration mistake that caused B-03 (webClientId must be a "Web
// application" OAuth 2.0 client — using the iOS client here breaks Android
// sign-in and causes backend audience mismatch).
const googleAuth = (Constants.expoConfig?.extra?.googleAuth ?? {}) as {
  iosClientId?: string
  webClientId?: string
}
if (__DEV__ && (!googleAuth.iosClientId || !googleAuth.webClientId)) {
  console.warn(
    '[auth] googleAuth.iosClientId / googleAuth.webClientId missing from app.json expo.extra — Google Sign-In will fail.',
  )
}
GoogleSignin.configure({
  iosClientId: googleAuth.iosClientId,
  webClientId: googleAuth.webClientId,
})

// Dynamic import — expo-apple-authentication crashes on web
const AppleAuthentication = Platform.OS === 'ios'
  ? require('expo-apple-authentication')
  : null

type Mode = 'login' | 'register' | 'forgot'

export default function LoginScreen() {
  const { colors } = useTheme()
  const router = useRouter()
  const { signInWithTokens, user } = useAuth()
  // A guest session is what this screen exists to keep: it changes the subtitle,
  // puts the one-tap providers first, and is the precondition for "merged".
  const isGuest = capabilitiesFor(user).isGuest
  const { show: showToast } = useToast()
  const { t: translate } = useLanguage()

  /**
   * Says so when the sign-in did not bring the reader's earlier work across.
   *
   * <p>The server has reported this since guest sessions shipped and no client read it, so someone
   * whose highlights and progress stayed on the abandoned guest row was simply landed in their new
   * account as if nothing had happened. It is indistinguishable, from their side, from the data
   * having been deleted — and silence is the one response that makes it look deliberate.</p>
   *
   * <p>Long, because it asks the reader to notice something rather than confirming what they just
   * did. Not a blocking dialog: they ARE signed in, and there is nothing for them to decide here.</p>
   *
   * <p>"Merged" is claimed only when it is known: the reader was a guest, the guest bearer actually
   * went out (`sentBearer` — a failed refresh sends none), and the server reported no skip. A guest
   * whose bearer did NOT go out lost the merge just the same, though the server saw nothing to
   * report — so that is a skip too. `wasGuest` is read before the call: afterwards `user` is the
   * account.</p>
   */
  const warnIfNothingCarried = (result: authApi.MobileAuthResult, wasGuest: boolean) => {
    const skipped = result.guestMergeSkipped ?? (wasGuest && !result.sentBearer ? 'no_bearer' : null)
    if (!skipped) return wasGuest ? showMerged() : undefined
    showToast({ message: translate('guest.progressNotCarried'), variant: 'error', duration: 9000 })
  }
  const showMerged = () => showToast({ message: translate('guest.merged'), variant: 'success', duration: 4000 })
  const [loading, setLoading] = useState(false)
  // Which tab this screen opens on.
  //
  // It read no params at all, so "Create free account" on Profile — the one CTA
  // whose whole job is turning a guest into an account — landed the reader on
  // *Sign in*, with an empty password field and no account to put in it.
  //
  // A `useState` INITIALISER and deliberately not a `useEffect` that syncs on
  // param change: the tabs below are the user's to switch, and a syncing effect
  // would yank them back to Register the moment anything re-rendered after they
  // tapped Sign in. The param decides the first frame and then has no further
  // opinion. Everything other than `register` (including the twelve call sites
  // that pass nothing) keeps landing on Sign in.
  //
  // `then=back`: opened over the reader (the guest word nudge) — dismiss back to
  // the same place instead of landing on Library.
  const params = useLocalSearchParams<{ mode?: string; then?: string }>()
  const [mode, setMode] = useState<Mode>(() => (params.mode === 'register' ? 'register' : 'login'))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [forgotSent, setForgotSent] = useState(false)

  // Keyboard "next/go" chain so the device keyboard advances focus instead of
  // the user tapping each input. Matches the PWA form ergonomics where the
  // browser handles this automatically via tab order.
  const emailRef = useRef<TextInput>(null)
  const passwordRef = useRef<TextInput>(null)

  const resetForm = () => { setEmail(''); setPassword(''); setName(''); setError(''); setForgotSent(false) }
  const switchMode = (m: Mode) => { resetForm(); setMode(m) }
  // From a failed Register to Sign in, keeping the address they just typed. The
  // guest token is untouched, so signing in merges it. Says nothing about WHY
  // registration failed — we do not reveal whether an email has an account.
  const switchToSignIn = () => { setError(''); setPassword(''); setMode('login') }

  // Editing retires the error the edit is answering.
  //
  // `setError('')` ran only on the next submit, and `onChangeText` cleared
  // nothing — so "Password must be at least 8 characters." stayed red while the
  // user typed the ninth, tenth and fourteenth. The form was telling them they
  // were still wrong about something they had just fixed.
  const changeEmail = (text: string) => { setEmail(text); if (error) setError('') }
  const changePassword = (text: string) => { setPassword(text); if (error) setError('') }

  const handleEmailAuth = async () => {
    // Guard: the submit button is disabled while `loading`, but keyboard
    // "go"/"return" can still fire onSubmitEditing while a request is in-flight.
    if (loading) return
    setError('')
    if (!email.trim()) { setError('Email is required.'); return }
    // Checked here so the server's answer stays truthful. Sending "notanemail"
    // came back as "Invalid email or password" — a statement about a credential
    // pair, to someone who has not entered an address. Deliberately permissive:
    // it rejects what cannot be an address, not what does not look like one.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) {
      setError('That does not look like an email address.')
      return
    }
    if (mode !== 'forgot' && password.length < 8) { setError('Password must be at least 8 characters.'); return }

    setLoading(true)
    try {
      if (mode === 'forgot') {
        await authApi.forgotPassword(email.trim())
        setForgotSent(true)
      } else if (mode === 'register') {
        const wasGuest = isGuest
        const result = await authApi.registerWithEmail(email.trim(), password, name.trim() || undefined)
        await signInWithTokens(result.accessToken, result.refreshToken, result.user)
        warnIfNothingCarried(result, wasGuest)
        landAfterAuth(result.user)
      } else {
        const wasGuest = isGuest
        const result = await authApi.loginWithEmail(email.trim(), password)
        await signInWithTokens(result.accessToken, result.refreshToken, result.user)
        warnIfNothingCarried(result, wasGuest)
        landAfterAuth(result.user)
      }
    } catch (e: any) {
      setError(e.message || 'Something went wrong.')
    } finally {
      setLoading(false)
    }
  }

  /**
   * Where a successful sign-in lands.
   *
   * Every path used to call `router.back()`, which returns to whatever screen
   * opened the login modal — usually Profile, because that is where the "Sign
   * in" button lives. So signing in dropped the reader on a settings screen
   * instead of on their books. `replace` rather than `push` so Back does not
   * walk into the login form of an account you are already signed into.
   *
   * A brand-new account has no native language, and without one the reader's
   * core feature translates English into English. So a new account is sent to
   * the question first, and everyone else straight to their books.
   *
   * The decision is `shouldAskForLanguage`, the same function the root gate
   * uses — two copies of this rule would drift, and the failure would be
   * invisible: either a returning reader interrogated on every sign-in, or a
   * new one never asked at all. The freshly returned `user` is passed rather
   * than read from context because `signInWithTokens` has not propagated yet.
   */
  const landAfterAuth = (_u: UserDto) => {
    // One navigation, and no opinion about the language question.
    //
    // This used to decide the landing itself and then run `dismissAll()` before
    // `replace()`. Both were mine, and both were wrong. Two copies of the rule
    // meant two places to be wrong in; and expo-router queues navigations,
    // computing the REPLACE against a route tree that has not yet absorbed the
    // POP_TO_TOP dispatched in the same drain — the one place on the register
    // path where the landing could silently go missing, which is exactly the
    // symptom QA reported three times.
    //
    // The question is now asked by `app/(tabs)/_layout.tsx` during render, on
    // the screen the reader lands on. This function's whole job is to leave the
    // auth modal.
    if (params.then === 'back' && router.canGoBack()) { router.back(); return }
    router.replace('/(tabs)/library')
  }

  const handleGoogleSignIn = async () => {
    const wasGuest = isGuest
    setLoading(true)
    try {
      await GoogleSignin.hasPlayServices()
      const response = await GoogleSignin.signIn()
      const idToken = response.data?.idToken
      if (!idToken) throw new Error('No ID token')

      const result = await authApi.loginWithGoogle(idToken)
      await signInWithTokens(result.accessToken, result.refreshToken, result.user)
      warnIfNothingCarried(result, wasGuest)
      landAfterAuth(result.user)
    } catch (e: any) {
      if (e?.code !== 'SIGN_IN_CANCELLED') {
        // Surface the underlying GoogleSignin error (DEVELOPER_ERROR,
        // SIGN_IN_REQUIRED, PLAY_SERVICES_NOT_AVAILABLE, …) so users
        // and bug reports can pinpoint the actual cause instead of a
        // generic "failed".
        const code = e?.code ? String(e.code) : ''
        const msg = e?.message ? String(e.message) : ''
        const detail = [code, msg].filter(Boolean).join(': ') || 'unknown error'
        if (__DEV__) console.warn('[google-signin]', { code, message: msg, raw: e })
        Alert.alert('Google sign-in failed', detail)
      }
    } finally {
      setLoading(false)
    }
  }

  const handleAppleSignIn = async () => {
    if (!AppleAuthentication) return
    const wasGuest = isGuest
    setLoading(true)
    try {
      const credential = await AppleAuthentication.signInAsync({
        requestedScopes: [
          AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
          AppleAuthentication.AppleAuthenticationScope.EMAIL,
        ],
      })

      if (!credential.identityToken) {
        throw new Error('No identity token')
      }

      const fullName = credential.fullName
        ? [credential.fullName.givenName, credential.fullName.familyName]
            .filter(Boolean)
            .join(' ') || null
        : null

      const result = await authApi.loginWithApple(
        credential.identityToken,
        fullName,
        credential.email,
      )

      await signInWithTokens(result.accessToken, result.refreshToken, result.user)
      warnIfNothingCarried(result, wasGuest)
      landAfterAuth(result.user)
    } catch (e: any) {
      if (e.code !== 'ERR_REQUEST_CANCELED') {
        Alert.alert('Error', 'Apple sign-in failed')
      }
    } finally {
      setLoading(false)
    }
  }

  const inputStyle = [styles.input, {
    backgroundColor: colors.surface,
    color: colors.text,
    borderColor: colors.border,
    fontFamily: fonts.sans,
  }]

  // Layout, not permission: a guest is one tap from keeping everything, so the
  // password-free providers go first for them.
  const socialFirst = isGuest

  const divider = (
    <View style={[styles.divider, { borderColor: colors.border }]}>
      <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
      <Text style={[styles.dividerText, { color: colors.textSecondary, fontFamily: fonts.sans }]}>or</Text>
      <View style={[styles.dividerLine, { backgroundColor: colors.border }]} />
    </View>
  )

  const social = (
    <>
      <TouchableOpacity
        style={[styles.button, styles.googleButton]}
        onPress={handleGoogleSignIn}
        disabled={loading}
      >
        <Ionicons name="logo-google" size={20} color="#fff" style={{ marginRight: 8 }} />
        <Text style={[styles.buttonText, { fontFamily: fonts.sansMedium }]}>Continue with Google</Text>
      </TouchableOpacity>

      {Platform.OS === 'ios' && AppleAuthentication && (
        <AppleAuthentication.AppleAuthenticationButton
          buttonType={mode === 'register'
            ? AppleAuthentication.AppleAuthenticationButtonType.SIGN_UP
            : AppleAuthentication.AppleAuthenticationButtonType.SIGN_IN}
          buttonStyle={AppleAuthentication.AppleAuthenticationButtonStyle.BLACK}
          cornerRadius={8}
          style={styles.appleButton}
          onPress={handleAppleSignIn}
        />
      )}
    </>
  )

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: colors.background }}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        <Ionicons name="book" size={48} color={colors.primary} style={{ marginBottom: 12 }} />
        <Text style={[styles.brand, { color: colors.text, fontFamily: fonts.serifBold }]}>TextStack</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary, fontFamily: fonts.sans }]}>
          {isGuest ? translate('guest.loginSubtitle') : 'Your reading journey starts here'}
        </Text>

        {/* A guest is one tap from keeping everything: the providers that need no
            password go first, the email form after. */}
        {socialFirst && mode !== 'forgot' && <>{social}{divider}</>}

        {/* Mode tabs */}
        {mode !== 'forgot' && (
          <View style={styles.tabs}>
            <TouchableOpacity
              style={[styles.tab, mode === 'login' && { borderBottomColor: colors.primary }]}
              onPress={() => switchMode('login')}
            >
              <Text style={[styles.tabText, {
                color: mode === 'login' ? colors.primary : colors.textSecondary,
                fontFamily: fonts.sansMedium,
              }]}>Sign in</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.tab, mode === 'register' && { borderBottomColor: colors.primary }]}
              onPress={() => switchMode('register')}
            >
              <Text style={[styles.tabText, {
                color: mode === 'register' ? colors.primary : colors.textSecondary,
                fontFamily: fonts.sansMedium,
              }]}>Register</Text>
            </TouchableOpacity>
          </View>
        )}

        {mode === 'forgot' && forgotSent ? (
          <View style={styles.forgotSent}>
            <Ionicons name="mail-outline" size={32} color={colors.primary} />
            <Text style={[styles.forgotSentText, { color: colors.text, fontFamily: fonts.sans }]}>
              If an account exists for {email}, we sent a reset link.
            </Text>
            <TouchableOpacity onPress={() => switchMode('login')}>
              <Text style={[styles.linkText, { color: colors.primary, fontFamily: fonts.sansMedium }]}>
                Back to sign in
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {mode === 'forgot' && (
              <Text style={[styles.forgotTitle, { color: colors.text, fontFamily: fonts.sansMedium }]}>
                Reset password
              </Text>
            )}

            {mode === 'register' && (
              <TextInput
                style={inputStyle}
                placeholder="Name (optional)"
                placeholderTextColor={colors.textSecondary}
                value={name}
                onChangeText={setName}
                autoCapitalize="words"
                autoComplete="name"
                textContentType="name"
                returnKeyType="next"
                blurOnSubmit={false}
                onSubmitEditing={() => emailRef.current?.focus()}
              />
            )}

            <TextInput
              ref={emailRef}
              style={inputStyle}
              placeholder="Email"
              placeholderTextColor={colors.textSecondary}
              value={email}
              onChangeText={changeEmail}
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="email"
              textContentType="emailAddress"
              returnKeyType={mode === 'forgot' ? 'go' : 'next'}
              blurOnSubmit={mode === 'forgot'}
              onSubmitEditing={
                mode === 'forgot'
                  ? handleEmailAuth
                  : () => passwordRef.current?.focus()
              }
            />

            {mode !== 'forgot' && (
              <TextInput
                ref={passwordRef}
                style={inputStyle}
                placeholder="Password"
                placeholderTextColor={colors.textSecondary}
                value={password}
                onChangeText={changePassword}
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete={mode === 'register' ? 'password-new' : 'password'}
                textContentType={mode === 'register' ? 'newPassword' : 'password'}
                returnKeyType="go"
                onSubmitEditing={handleEmailAuth}
              />
            )}

            {!!error && (
              <Text style={[styles.error, { fontFamily: fonts.sans }]}>{error}</Text>
            )}

            {/* Any Register failure — including a taken email, which the server
                words as "invalid email or password" — offers the way to Sign in. */}
            {!!error && mode === 'register' && (
              <TouchableOpacity onPress={switchToSignIn}>
                <Text style={[styles.linkText, { color: colors.primary, fontFamily: fonts.sansMedium }]}>
                  {translate('guest.haveAccount')}
                </Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={[styles.button, styles.emailButton, { backgroundColor: colors.primary }]}
              onPress={handleEmailAuth}
              disabled={loading}
            >
              {loading ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={[styles.buttonText, { fontFamily: fonts.sansMedium }]}>
                  {mode === 'forgot' ? 'Send reset link' : mode === 'login' ? 'Sign in' : 'Create account'}
                </Text>
              )}
            </TouchableOpacity>

            {mode === 'login' && (
              <TouchableOpacity onPress={() => switchMode('forgot')}>
                <Text style={[styles.linkText, { color: colors.textSecondary, fontFamily: fonts.sans }]}>
                  Forgot password?
                </Text>
              </TouchableOpacity>
            )}

            {mode === 'forgot' && (
              <TouchableOpacity onPress={() => switchMode('login')}>
                <Text style={[styles.linkText, { color: colors.textSecondary, fontFamily: fonts.sans }]}>
                  Back to sign in
                </Text>
              </TouchableOpacity>
            )}

            {!socialFirst && mode !== 'forgot' && <>{divider}{social}</>}
          </>
        )}

        <TouchableOpacity style={styles.cancelButton} onPress={() => router.back()}>
          <Text style={[styles.cancelText, { color: colors.textSecondary, fontFamily: fonts.sansMedium }]}>Cancel</Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  brand: { fontSize: 32, marginBottom: 8 },
  subtitle: { fontSize: 15, marginBottom: 24, textAlign: 'center' },
  tabs: {
    flexDirection: 'row',
    width: '100%',
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
  },
  tabText: { fontSize: 15 },
  input: {
    width: '100%',
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 15,
    marginBottom: 10,
  },
  error: {
    color: '#ef4444',
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 8,
  },
  button: {
    width: '100%',
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
    marginBottom: 12,
    flexDirection: 'row',
    justifyContent: 'center',
  },
  emailButton: {},
  googleButton: {
    backgroundColor: '#4285F4',
  },
  buttonText: { color: '#fff', fontSize: 16 },
  appleButton: {
    width: '100%',
    height: 48,
    marginBottom: 12,
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginVertical: 16,
  },
  dividerLine: { flex: 1, height: 1 },
  dividerText: { marginHorizontal: 12, fontSize: 13 },
  linkText: {
    fontSize: 13,
    marginTop: 4,
    marginBottom: 8,
  },
  forgotTitle: {
    fontSize: 18,
    marginBottom: 16,
    textAlign: 'center',
  },
  forgotSent: {
    alignItems: 'center',
    padding: 16,
    gap: 12,
  },
  forgotSentText: {
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
  },
  cancelButton: { marginTop: 8 },
  cancelText: { fontSize: 16 },
})
