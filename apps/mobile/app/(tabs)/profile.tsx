import { useState } from 'react'
import { View, Text, StyleSheet, TouchableOpacity, TextInput, Alert, ActivityIndicator, ScrollView, Linking, Platform } from 'react-native'
import { useRouter } from 'expo-router'
import { Image } from 'expo-image'
import { Ionicons } from '@expo/vector-icons'
import Constants from 'expo-constants'
import * as Updates from 'expo-updates'
import * as Application from 'expo-application'

type IoniconsName = React.ComponentProps<typeof Ionicons>['name']
// Lazy-loaded — requires native build
let ImagePicker: typeof import('expo-image-picker') | null = null
try { ImagePicker = require('expo-image-picker') } catch {}
import { useAuth } from '../../src/context/AuthContext'
import { useTheme } from '../../src/context/ThemeContext'
import { useLanguage } from '../../src/context/LanguageContext'
import { useOnline } from '../../src/hooks/useOnline'
import { useNativeLanguage } from '../../src/context/NativeLanguageContext'
import { capabilitiesFor } from '../../src/lib/capabilities'
import { signOutIntent } from '../../src/lib/profileActions'
import { getLanguage } from '../../src/data/languages'
import { LanguagePickerModal } from '../../src/components/LanguagePickerModal'
import { VocabReminderSettingsRow } from '../../src/components/profile/VocabReminderSettingsRow'
import { StorageQuotaRow } from '../../src/components/library/StorageQuotaRow'
import { authApi, getStorageUrl, getAnonymousReader } from '@textstack/shared'
import { deleteAccount } from '../../src/lib/api'
import { getAnonAvatarSource } from '../../src/lib/anonAvatarSource'
import { versionLine, updateLine } from '../../src/lib/buildInfo'
import { fonts } from '../../src/theme/typography'

// Read once at module load: none of it changes while the app is running, and
// Updates.* is a native constant rather than something to re-read.
//
// The version and build number come from the installed package, not from the
// manifest. The manifest carries the versionCode EAS wrote at build time, and an
// update published by `eas update` has none — so after any OTA the number would
// simply vanish, exactly when someone is trying to report which build they hold.
//
// expo-application is a native module, and one that already ships here:
// expo-notifications depends on it, so it is compiled into the APK already.
// Measured before and after adding it as a direct dependency and the runtime
// fingerprint is 1065515f… both ways, so this still travels as an OTA.
const BUILD = {
  version: Application.nativeApplicationVersion ?? Constants.expoConfig?.version,
  versionCode: Application.nativeBuildVersion,
  // expo-updates' web shim hardcodes isEnabled: true and isEmbeddedLaunch:
  // false, so on web the pair reads as "an update is applied" when no update
  // mechanism exists at all. Web is a dev preview and the e2e harness here,
  // never a shipped target — say so rather than let the shim answer.
  isDev: __DEV__,
  updatesEnabled: Platform.OS !== 'web' && Updates.isEnabled,
  isEmbeddedLaunch: Updates.isEmbeddedLaunch,
  updateCreatedAt: Updates.createdAt,
}

// Shown on both branches of this screen. A tester who cannot sign in is exactly
// the person who needs to report which build they are on.
function BuildFooter() {
  const { colors } = useTheme()
  return (
    <View style={styles.buildInfo}>
      <Text style={[styles.buildText, { color: colors.textSecondary }]}>{versionLine(BUILD)}</Text>
      <Text style={[styles.buildText, { color: colors.textSecondary }]}>{updateLine(BUILD)}</Text>
    </View>
  )
}

const MENU_ITEMS = [
  { label: 'Reading Stats', icon: 'stats-chart-outline' as const, route: '/stats/' },
  { label: 'Highlights', icon: 'color-wand-outline' as const, route: '/highlights/' },
]


export default function ProfileScreen() {
  const { user, isAuthenticated, signOut, updateUser, getAccessToken } = useAuth()
  const { colors, themeMode, setThemeMode } = useTheme()
  const { t } = useLanguage()
  const { nativeLanguage, setNativeLanguage } = useNativeLanguage()
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [saving, setSaving] = useState(false)
  const [langPickerOpen, setLangPickerOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const online = useOnline()
  // One read of the policy for the whole screen. It used to be the raw guest flag
  // off the DTO, re-derived here and then spent on two render gates — and both
  // gates were on decoration (a pencil icon, a section border) while the live
  // controls under them, `startEdit` and `pickAvatar`, stayed open to a guest.
  // (Named rather than quoted above: `capabilityLiterals.test.ts` greps source
  // text and cannot tell a comment from a branch. Correct — it stays dumb.)
  const { isGuest, canUpload, canEditIdentity, canDeleteAccount, canSyncAcrossDevices } = capabilitiesFor(user)
  const anon = isGuest && user ? getAnonymousReader(user.id) : null
  const anonSource = anon && user ? getAnonAvatarSource(user.id) : null
  const displayName = anon ? anon.name : (user?.name || user?.email || '')
  const displaySubtitle = anon ? 'Anonymous reader' : (user?.email || '')
  const avatarLetter = anon
    ? anon.name.split(' ').map(n => n[0]).join('').toUpperCase()
    : (user?.name || user?.email || '?').charAt(0).toUpperCase()

  const startEdit = () => {
    if (!canEditIdentity) return
    setEditName(user?.name || '')
    setEditing(true)
  }

  const saveProfile = async () => {
    setSaving(true)
    try {
      const token = await getAccessToken()
      if (!token) return
      const res = await authApi.updateProfile(editName.trim() || null, token)
      await updateUser(res.user)
      setEditing(false)
    } catch (e: any) {
      Alert.alert('Error', e.message || 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const pickAvatar = async () => {
    // Belt to the `disabled` braces below. This function ends in
    // `authApi.uploadAvatar` — a real `POST /me/profile/avatar` on a row whose
    // face is a generated animal nobody chose and nobody sees. Guarded here too
    // because the last version of this screen guarded only the icon.
    if (!canEditIdentity) return
    if (!ImagePicker) { Alert.alert('Not available', 'Image picker requires a native build'); return }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.8,
    })
    if (result.canceled || !result.assets[0]) return
    setSaving(true)
    try {
      const token = await getAccessToken()
      if (!token) return
      const res = await authApi.uploadAvatar(result.assets[0].uri, token)
      await updateUser(res.user)
    } catch (e: any) {
      // Map HTTP status → actionable copy (B-20). Before this, every failure
      // surfaced as the same generic "Upload failed" even though the fix
      // depends entirely on *why* it failed (wrong size vs wrong format vs
      // network). The backend error message comes through as `e.message`
      // for anything the codes below don't cover.
      const status: number | undefined = e?.status
      let title = 'Upload failed'
      let message = e?.message || 'Something went wrong. Please try again.'
      if (status === 413) {
        title = 'Image too large'
        message = 'The photo is over the server limit. Pick a smaller image and try again.'
      } else if (status === 415 || status === 400) {
        title = 'Unsupported image'
        message = 'TextStack accepts JPG or PNG photos. Try a different file.'
      } else if (status === 401 || status === 403) {
        title = 'Not signed in'
        message = 'Your session expired. Sign in again and retry the upload.'
      } else if (typeof status === 'number' && status >= 500) {
        title = 'Server error'
        message = 'Our servers are having trouble. Please try again in a minute.'
      } else if (!status) {
        // No HTTP response = network-level failure (offline, DNS, etc.)
        title = 'Network error'
        message = 'Check your connection and try again.'
      }
      Alert.alert(title, message)
    } finally {
      setSaving(false)
    }
  }

  // Permanently delete the account. Two-step confirm before the
  // irreversible network call: a warning explaining what's lost, then a
  // final confirm. On success we sign out (clears SecureStore token/user
  // + per-user caches) and the (tabs) layout drops back to the signed-out
  // state; on failure we keep the user signed in and surface the error.
  const performDelete = async () => {
    setDeleting(true)
    try {
      const token = await getAccessToken()
      if (!token) {
        Alert.alert('Not signed in', 'Your session expired. Sign in again and retry.')
        return
      }
      await deleteAccount(token)
      await signOut()
      router.replace('/(tabs)')
    } catch (e: any) {
      const status: number | undefined = e?.status
      let message = e?.message || 'Something went wrong. Please try again.'
      if (status === 401 || status === 403) {
        message = 'Your session expired. Sign in again and retry.'
      } else if (typeof status === 'number' && status >= 500) {
        message = 'Our servers are having trouble. Please try again in a minute.'
      } else if (!status) {
        message = 'Check your connection and try again.'
      }
      Alert.alert('Delete failed', message)
    } finally {
      setDeleting(false)
    }
  }

  const leave = async () => { await signOut(); router.replace('/') }

  // For an account this is the row it has always been: tap, tokens cleared, back
  // to the front door. For a guest the same tap is irreversible — the tokens in
  // SecureStore are the only key to a server row that `GuestCleanupWorker`
  // deliberately keeps forever — so it gets a destructive confirm that says what
  // goes, in words, instead of asking "are you sure". The branch is
  // `signOutIntent`, unit-tested in `src/lib/profileActions.test.ts`.
  const handleSignOut = () => {
    if (signOutIntent(user) === 'immediate') { void leave(); return }
    Alert.alert(
      t('guest.signOutTitle'),
      t('guest.signOutMessage'),
      [
        { text: t('guest.signOutCancel'), style: 'cancel' },
        { text: t('guest.signOutConfirm'), style: 'destructive', onPress: () => { void leave() } },
      ],
    )
  }

  const confirmDelete = () => {
    Alert.alert(
      'Delete account?',
      'This permanently deletes your account and ALL your data — uploaded books, highlights, vocabulary, and reading history. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Continue',
          style: 'destructive',
          onPress: () =>
            Alert.alert(
              'Are you absolutely sure?',
              'There is no way to recover your account or data after this.',
              [
                { text: 'Keep my account', style: 'cancel' },
                { text: 'Delete account', style: 'destructive', onPress: performDelete },
              ],
            ),
        },
      ],
    )
  }

  if (!isAuthenticated) {
    return (
      <View style={[styles.center, { backgroundColor: colors.background }]}>
        <Ionicons name="person-circle-outline" size={64} color={colors.border} />
        <Text style={[styles.title, { color: colors.text }]}>Profile</Text>
        <Text style={[styles.subtitle, { color: colors.textSecondary }]}>Sign in to track your reading</Text>
        <TouchableOpacity
          style={[styles.loginButton, { backgroundColor: colors.primary }]}
          onPress={() => router.push('/(auth)/login')}
        >
          <Text style={styles.loginText}>Sign In</Text>
        </TouchableOpacity>
        <BuildFooter />
      </View>
    )
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.background }]} contentContainerStyle={styles.contentContainer}>
      <View style={styles.header}>
        <View style={styles.avatarOuter}>
          <TouchableOpacity
            style={[styles.avatarWrapper, { backgroundColor: anon && !user?.picture ? anon.color : colors.primary }]}
            onPress={pickAvatar}
            disabled={!canEditIdentity}
            activeOpacity={0.7}
          >
            {user?.picture ? (
              <Image source={user.picture.startsWith('http') ? user.picture : getStorageUrl(user.picture)} style={styles.avatar} contentFit="cover" />
            ) : anonSource ? (
              <Image source={anonSource} style={styles.anonAnimal} contentFit="contain" />
            ) : (
              <Text style={styles.avatarLetter}>{avatarLetter}</Text>
            )}
            {/* The camera badge is the promise that the avatar is tappable. Shown
                only where the tap does something, so the affordance and the
                capability cannot drift apart the way the pencil did. */}
            {canEditIdentity && (
              <View style={styles.avatarBadge}>
                <Ionicons name="camera" size={14} color="#fff" />
              </View>
            )}
          </TouchableOpacity>
          <View
            style={[
              styles.statusDot,
              { backgroundColor: online ? '#4caf50' : '#9e9e9e', borderColor: colors.background },
            ]}
            accessibilityLabel={online ? 'Online' : 'Offline'}
          />
        </View>
        {editing ? (
          <View style={styles.editRow}>
            <TextInput
              style={[styles.editInput, { color: colors.text, borderColor: colors.border, fontFamily: fonts.sans }]}
              value={editName}
              onChangeText={setEditName}
              placeholder="Name"
              placeholderTextColor={colors.textSecondary}
              autoFocus
              autoCorrect={false}
              textContentType="name"
              autoComplete="name"
              returnKeyType="done"
              onSubmitEditing={saveProfile}
              accessibilityLabel="Edit display name"
            />
            <TouchableOpacity onPress={saveProfile} disabled={saving} style={[styles.saveBtn, { backgroundColor: colors.primary }]}>
              {saving ? <ActivityIndicator size="small" color="#fff" /> : <Text style={{ color: '#fff', fontFamily: fonts.sansMedium }}>Save</Text>}
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setEditing(false)}>
              <Text style={{ color: colors.textSecondary, fontFamily: fonts.sans }}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <TouchableOpacity
            onPress={startEdit}
            // Was ungated while the pencil beside it was hidden: a guest tapping
            // their own name dropped into the edit field and could PUT a name onto
            // a throwaway identity. The gate belongs on the touch target.
            disabled={!canEditIdentity}
            activeOpacity={0.7}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
          >
            <Text style={[styles.name, { color: colors.text }]}>{displayName}</Text>
            {canEditIdentity && <Ionicons name="pencil" size={14} color={colors.textSecondary} />}
          </TouchableOpacity>
        )}
        <Text style={[styles.email, { color: colors.textSecondary }]}>{displaySubtitle}</Text>
      </View>

      <View style={styles.menu}>
        {/* Upload space lives here rather than mid-list on Library, where it
            was an unlabelled bar between the upload button and the search box.

            Still behind `canUpload`, but the reason has inverted. It used to be
            "don't show a guest 0 B of 50 MB used, it is an allowance they are not
            permitted to spend". Since 2026-09-06 they are (ADR-014 §3), so the row
            is now shown to them on purpose: it is their real figure, on the tier
            that meters their real upload, and hiding it would understate what the
            app already lets them do.

            The gate is not redundant. `canUpload` is false with no session, and
            `StorageQuotaRow` fetches `/me/books/quota` on mount — unconditional,
            this fires a token-less request that can only 401. */}
        {canUpload && <StorageQuotaRow />}

        {MENU_ITEMS.map(item => (
          <TouchableOpacity
            key={item.route}
            style={[styles.menuItem, { borderBottomColor: colors.border }]}
            onPress={() => router.push(item.route)}
            activeOpacity={0.7}
          >
            <Ionicons name={item.icon} size={20} color={colors.textSecondary} style={styles.menuIcon} />
            <Text style={[styles.menuText, { color: colors.text }]}>{item.label}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        ))}

        {/* "Language" (the INTERFACE language) used to sit here, and it was the same dead control
            as "Learning" below: a chip row built from `supportedLanguages`, which is `['en']` — one
            chip, permanently selected, and tapping it called switchLanguage('en'), a no-op state
            write to the value it already held. QA tapped it and filed it, exactly as predicted six
            lines down. It sat two rows above Theme, where three chips of the same shape really do
            work, which is what made it read as broken rather than as "only one language yet".
            A control with one option is not a control. It comes back when there is a second locale.
            Note this is NOT the native-language setting below — that one is real and works. */}

        {/* I know (native language) — searchable picker */}
        <TouchableOpacity
          style={[styles.menuItem, { borderBottomColor: colors.border }]}
          onPress={() => setLangPickerOpen(true)}
          activeOpacity={0.7}
        >
          <Ionicons name="chatbubble-outline" size={20} color={colors.textSecondary} style={styles.menuIcon} />
          <Text style={[styles.menuText, { color: colors.text }]}>I know</Text>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontFamily: fonts.sansMedium, fontSize: 14, color: colors.textSecondary }}>
              {getLanguage(nativeLanguage)?.englishName || nativeLanguage}
            </Text>
            <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
          </View>
        </TouchableOpacity>

        {/* "Learning" used to sit here: a row of chips built from TARGET_LANGUAGES,
            which is NATIVE_LANGUAGES.filter(code === 'en') — one chip, permanently
            selected, doing nothing. QA read it as a real setting and filed it twice:
            once as a styling inconsistency next to "I know" (a chevron row vs a chip
            row), and once as the reason a new account believed it was learning
            English. A control with one option is not a control. It comes back when
            the catalogue has a second language. */}

        {/* Theme switcher */}
        <View style={[styles.menuItem, { borderBottomColor: colors.border }]}>
          <Ionicons name={themeMode === 'dark' ? 'moon' : themeMode === 'light' ? 'sunny' : 'contrast-outline'} size={20} color={colors.textSecondary} style={styles.menuIcon} />
          <Text style={[styles.menuText, { color: colors.text }]}>Theme</Text>
          <View style={{ flexDirection: 'row', gap: 4 }}>
            {([['system', 'Auto'], ['light', 'Light'], ['dark', 'Dark']] as const).map(([mode, label]) => (
              <TouchableOpacity
                key={mode}
                onPress={() => setThemeMode(mode)}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 4,
                  borderRadius: 12,
                  backgroundColor: themeMode === mode ? colors.primaryLight : 'transparent',
                }}
                activeOpacity={0.7}
              >
                <Text style={{ fontFamily: fonts.sansMedium, fontSize: 13, color: themeMode === mode ? colors.primary : colors.textSecondary }}>
                  {label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Daily vocabulary review reminder */}
        <VocabReminderSettingsRow />

        {/* Info pages */}
        {([
          { label: 'About', icon: 'information-circle-outline' as const, route: '/about', value: versionLine(BUILD, { short: true }) },
          { label: 'Privacy', icon: 'shield-outline' as const, route: '/privacy' },
          { label: 'Terms', icon: 'document-text-outline' as const, route: '/terms' },
          // Users upload their own books from this app, so rights holders need a
          // route to the takedown process from inside it. The process itself is a
          // web page, hence the external link rather than a route.
          { label: 'Copyright / DMCA', icon: 'alert-circle-outline' as const, url: 'https://textstack.app/dmca' },
          { label: 'Contact', icon: 'mail-outline' as const, route: '/contact' },
        ] as { label: string; icon: IoniconsName; route?: string; url?: string; value?: string }[]).map(item => (
          <TouchableOpacity
            key={item.route ?? item.url}
            style={[styles.menuItem, { borderBottomColor: colors.border }]}
            onPress={() => (item.url ? Linking.openURL(item.url) : router.push(item.route!))}
            activeOpacity={0.7}
          >
            <Ionicons name={item.icon} size={20} color={colors.textSecondary} style={styles.menuIcon} />
            <Text style={[styles.menuText, { color: colors.text }]}>{item.label}</Text>
            {item.value ? (
              <Text style={[styles.menuValue, { color: colors.textSecondary }]}>{item.value}</Text>
            ) : null}
            <Ionicons name="chevron-forward" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        ))}

        {canSyncAcrossDevices ? (
          <TouchableOpacity
            style={[styles.menuItem, { borderBottomColor: 'transparent', marginTop: 24 }]}
            // Leave for the front door afterwards. Staying put would drop the
            // user on Profile's own signed-out state, and Library — the first
            // tab — is now a sign-in wall for them; `/` routes a guest to Discover.
            onPress={handleSignOut}
            activeOpacity={0.7}
          >
            <Ionicons name="log-out-outline" size={20} color={colors.error} style={styles.menuIcon} />
            <Text style={[styles.menuText, { color: colors.error }]}>Sign Out</Text>
          </TouchableOpacity>
        ) : (
          /* The guest footer. Keyed on `canSyncAcrossDevices` because that is the
             single true thing an account adds — and this is the only place in the
             app where we ask for one, so it is the only place that has to be honest
             about why. The order is deliberate: the reason, then the way forward,
             then the exit — instead of a red "Sign Out" that quietly meant delete. */
          <View style={[styles.guestBlock, { borderTopColor: colors.border }]}>
            <Text style={[styles.guestBanner, { color: colors.textSecondary }]}>{t('guest.banner')}</Text>
            <TouchableOpacity
              style={[styles.guestCta, { backgroundColor: colors.primary }]}
              // The button says "Create free account", so the screen it opens
              // has to be the Register tab. It opened on Sign in.
              onPress={() => router.push({ pathname: '/(auth)/login', params: { mode: 'register' } })}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={t('guest.createAccount')}
            >
              <Text style={styles.guestCtaText}>{t('guest.createAccount')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleSignOut}
              activeOpacity={0.7}
              style={styles.guestSignOut}
              accessibilityRole="button"
              accessibilityLabel={t('guest.signOut')}
            >
              <Text style={[styles.guestSignOutText, { color: colors.textSecondary }]}>{t('guest.signOut')}</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* Danger zone — destructive, visually separated from normal settings.
            Hidden without an account: there is nothing a guest can ask us to
            delete that signing out has not already put out of reach. */}
        {canDeleteAccount && (
          <View style={[styles.dangerZone, { borderColor: colors.error }]}>
            <Text style={[styles.sectionLabel, { color: colors.error, marginTop: 0 }]}>Danger zone</Text>
            <TouchableOpacity
              style={styles.dangerRow}
              onPress={confirmDelete}
              disabled={deleting}
              activeOpacity={0.7}
              accessibilityLabel="Delete account"
            >
              {deleting ? (
                <ActivityIndicator size="small" color={colors.error} style={styles.menuIcon} />
              ) : (
                <Ionicons name="trash-outline" size={20} color={colors.error} style={styles.menuIcon} />
              )}
              <View style={{ flex: 1 }}>
                <Text style={[styles.menuText, { color: colors.error }]}>Delete account</Text>
                <Text style={[styles.dangerHint, { color: colors.textSecondary }]}>
                  Permanently removes your account and all data. Cannot be undone.
                </Text>
              </View>
            </TouchableOpacity>
          </View>
        )}

        {/* Which build this is. A tester could not tell from inside the app
            whether they were holding the fixed version — and the two things
            that can lag differ: the native build only Play can replace, the JS
            bundle arrives on its own. */}
        <BuildFooter />
      </View>

      <LanguagePickerModal
        visible={langPickerOpen}
        onClose={() => setLangPickerOpen(false)}
        value={nativeLanguage}
        onChange={setNativeLanguage}
      />
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 8 },
  container: { flex: 1 },
  contentContainer: { paddingBottom: 40 },
  title: { fontFamily: fonts.serifBold, fontSize: 22, marginTop: 8 },
  subtitle: { fontFamily: fonts.sans, fontSize: 14 },
  loginButton: {
    marginTop: 12,
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 10,
  },
  loginText: { color: '#fff', fontFamily: fonts.sansMedium, fontSize: 15 },
  header: { alignItems: 'center', paddingVertical: 32 },
  avatarOuter: { position: 'relative', marginBottom: 14 },
  statusDot: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: 2,
  },
  avatarWrapper: {
    width: 88,
    height: 88,
    borderRadius: 44,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 12,
    elevation: 4,
    overflow: 'hidden',
  },
  avatar: { width: 88, height: 88, borderRadius: 44 },
  anonAnimal: { width: 72, height: 72 },
  avatarLetter: { color: '#fff', fontFamily: fonts.serifBold, fontSize: 36 },
  name: { fontFamily: fonts.serifBold, fontSize: 20 },
  email: { fontFamily: fonts.sans, fontSize: 14, marginTop: 4 },
  menu: { paddingHorizontal: 16, marginTop: 16 },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: 1,
  },
  menuIcon: { marginRight: 12 },
  menuText: { flex: 1, fontFamily: fonts.sans, fontSize: 16 },
  menuValue: { fontFamily: fonts.sans, fontSize: 14, marginRight: 8 },
  sectionLabel: { fontFamily: fonts.sansMedium, fontSize: 12, textTransform: 'uppercase', letterSpacing: 1, marginTop: 20, marginBottom: 4 },
  avatarBadge: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  editRow: { alignItems: 'center', gap: 8, width: '80%' },
  editInput: {
    width: '100%',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 16,
    textAlign: 'center',
  },
  saveBtn: {
    paddingHorizontal: 24,
    paddingVertical: 8,
    borderRadius: 8,
  },
  dangerZone: {
    marginTop: 32,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  dangerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 8,
  },
  dangerHint: { fontFamily: fonts.sans, fontSize: 12, marginTop: 2 },
  guestBlock: { marginTop: 24, paddingTop: 20, borderTopWidth: 1, alignItems: 'center', gap: 14 },
  guestBanner: { fontFamily: fonts.sans, fontSize: 13, lineHeight: 19, textAlign: 'center', paddingHorizontal: 8 },
  guestCta: { alignSelf: 'stretch', paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  guestCtaText: { color: '#fff', fontFamily: fonts.sansMedium, fontSize: 16 },
  guestSignOut: { paddingVertical: 8, paddingHorizontal: 16 },
  guestSignOutText: { fontFamily: fonts.sans, fontSize: 14 },
  buildInfo: { alignItems: 'center', marginTop: 32, marginBottom: 8, gap: 2 },
  buildText: { fontFamily: fonts.sans, fontSize: 11 },
})
