import { createContext, useContext, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { confirmationFor } from '../lib/languageOnboarding'
import { NativeModules, Platform } from 'react-native'
import { authApi, LANGUAGES } from '@textstack/shared'
import { useAuth } from './AuthContext'

// There is no TARGET_LANGUAGES any more. It was NATIVE_LANGUAGES.filter(code ===
// 'en') — one entry — and it backed a Profile row of chips with a single,
// permanently-selected option. QA read that row as a real setting and concluded
// the app thought they were learning English. The concept returns when the
// catalogue has a second language; until then it was state nothing could change
// and nothing read.

const NATIVE_KEY = 'textstack_native_language'
// Same key the web app uses, for the same reason — see `hasConfirmedLanguage`.
//
// The VALUE is who confirmed: a user id, or 'local' for a guest or signed-out
// session. It used to be the string '1', which made the confirmation belong to
// the INSTALL rather than to a person — so a device where one account answered
// never asked the next one. The sign-out branch below was supposed to prevent
// that and its comment says so, but it only fires on a sign-out that happens
// inside a running process, and registering a second account does not.
//
// Existing installs hold '1', which matches no owner, so everyone is asked once
// more. That is the correct answer to "who confirmed this?" when we do not know.
const CONFIRMED_KEY = 'textstack_native_language_confirmed'
const LOCAL_OWNER = 'local'

function isSupported(code: string): boolean {
  return LANGUAGES.some((l) => l.code === code)
}

function getDeviceLanguage(): string {
  try {
    const locale =
      Platform.OS === 'ios'
        ? NativeModules.SettingsManager?.settings?.AppleLocale ||
          NativeModules.SettingsManager?.settings?.AppleLanguages?.[0]
        : NativeModules.I18nManager?.localeIdentifier
    return locale?.split(/[-_]/)[0] || 'en'
  } catch {
    return 'en'
  }
}

interface NativeLanguageContextValue {
  nativeLanguage: string
  setNativeLanguage: (code: string) => void
  /**
   * Whether `nativeLanguage` is something the user actually chose, as opposed to
   * something we guessed. `nativeLanguage` alone cannot answer this: it is never
   * empty — it defaults to 'en' and only *maybe* becomes the device locale — so a
   * reader who has never been asked is indistinguishable from one who genuinely
   * reads English natively. That ambiguity is the whole bug: a QA account showed
   * "I know: English / Learning: English" with `nativeLanguage: null` on the
   * server, and translation quietly became English → English.
   *
   * Null while the answer is still being read from AsyncStorage. Callers that
   * gate UI on "has not chosen yet" must wait for a boolean rather than treating
   * null as false, or they will flash the prompt at every user on every launch.
   */
  hasConfirmedLanguage: boolean | null
}

const NativeLanguageContext = createContext<NativeLanguageContextValue>({
  nativeLanguage: 'en',
  setNativeLanguage: () => {},
  hasConfirmedLanguage: null,
})

export function NativeLanguageProvider({ children }: { children: ReactNode }) {
  const [nativeLanguage, setNativeState] = useState('en')
  // undefined until AsyncStorage answers; then the owner, or null for nobody.
  const [confirmedOwner, setConfirmedOwner] = useState<string | null | undefined>(undefined)
  const { user, getAccessToken, updateUser } = useAuth()
  // Who a confirmation would belong to right now.
  const ownerId = user?.id ?? LOCAL_OWNER
  // Tri-state for callers: null while storage is still answering, then whether
  // THIS account has confirmed — not whether anyone on this device ever did.
  const hasConfirmedLanguage = confirmationFor(confirmedOwner, ownerId)
  const prevUserIdRef = useRef<string | undefined>(user?.id)
  // Set once the server→local mirror has applied an authoritative value, so the
  // (async) AsyncStorage load below can't clobber it back on a cold launch where
  // the two resolve in an arbitrary order.
  const serverLangAppliedRef = useRef(false)

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(NATIVE_KEY),
      AsyncStorage.getItem(CONFIRMED_KEY),
    ]).then(([native, confirmed]) => {
      // Resolve first and unconditionally: a failed read must still land on a
      // value (below, in .catch) rather than leaving this undefined forever, or
      // anything gated on it waits for an answer that never comes.
      setConfirmedOwner(confirmed ?? null)
      // The signed-in user's server language wins — don't overwrite it with the
      // stale local value just because this async read happened to resolve last.
      if (!serverLangAppliedRef.current) {
        if (native && isSupported(native)) {
          setNativeState(native)
        } else {
          const device = getDeviceLanguage()
          if (isSupported(device)) setNativeState(device)
        }
      }
    }).catch(() => { setConfirmedOwner(null) })
  }, [])

  // Server → local: mirror the signed-in user's nativeLanguage into state +
  // AsyncStorage. THIS is what was missing — without it mobile stayed on the
  // local default ('en') even when the user had set Russian on the web/DB, so
  // the reader's translation gloss (book lang → native lang) had no valid target
  // and never appeared. Mirrors apps/web NativeLanguageContext.
  //
  // Keyed on user id + the server lang (primitives), NOT on local nativeLanguage,
  // so a local change pushed to the server (which round-trips via updateUser)
  // doesn't race the mirror back to the old value.
  useEffect(() => {
    const switched = prevUserIdRef.current !== user?.id
    prevUserIdRef.current = user?.id
    // On sign-out, fall back to the device default so a stale value from the
    // previous account doesn't leak into the next session.
    if (!user) {
      if (switched) {
        const device = getDeviceLanguage()
        setNativeState(isSupported(device) ? device : 'en')
        // Nothing to clear: the stored owner is a user id, and the signed-out
        // session's owner is 'local', so it already does not match. Removing the
        // key here would throw away a guest's own answer.
        serverLangAppliedRef.current = false
      }
      return
    }
    const serverLang = user.nativeLanguage
    if (!serverLang || !isSupported(serverLang)) return
    serverLangAppliedRef.current = true
    setNativeState(serverLang)   // idempotent — React skips if unchanged
    // A value on the server is a choice the user made, on some device, at some
    // point. Honour it as confirmed so a returning reader is never asked twice.
    //
    // Note what is deliberately NOT done here: web marks *any* signed-in user
    // confirmed even when the server field is empty (apps/web
    // NativeLanguageContext.tsx:108-114), because there it only silences a pulse
    // on an icon. Copying that would silence the onboarding prompt for exactly
    // the users it exists for — the ones the server has no answer for.
    setConfirmedOwner(ownerId)
    AsyncStorage.multiSet([[NATIVE_KEY, serverLang], [CONFIRMED_KEY, ownerId]]).catch(() => {})
  }, [user?.id, user?.nativeLanguage, user?.isGuest])

  // Local → server, when the server has no answer. Covers the guest who picks a
  // language and then registers, and the account created before this screen
  // existed. Reads AsyncStorage rather than state because on the register fast
  // path `user.id` changes before a just-written state update has flushed.
  //
  // Guests included. A guest session is a real `User` row and `PUT /me/profile`
  // takes their token, so an answer given before the session existed (owner
  // `'local'`) is adopted and pushed the moment one is minted.
  useEffect(() => {
    if (!user || user.nativeLanguage) return
    let cancelled = false
    ;(async () => {
      try {
        const [confirmed, stored] = await Promise.all([
          AsyncStorage.getItem(CONFIRMED_KEY),
          AsyncStorage.getItem(NATIVE_KEY),
        ])
        // A guest's answer belongs to whoever was holding the device, so the
        // account they register adopts it — once, by re-stamping the owner.
        // Without this the guest→register flow loses the language it just
        // collected and asks again. Leaving 'local' adoptable forever would be
        // the original bug wearing a different value.
        if (!cancelled && confirmed === LOCAL_OWNER) {
          setConfirmedOwner(ownerId)
          AsyncStorage.setItem(CONFIRMED_KEY, ownerId).catch(() => {})
        } else if (cancelled || confirmed !== ownerId) {
          return
        }
        if (!stored || !isSupported(stored)) return
        const token = await getAccessToken()
        if (cancelled || !token) return
        const res = await authApi.updateProfile(user.name ?? null, token, stored)
        if (!cancelled && res?.user) await updateUser(res.user)
      } catch {
        // Local value stands; the next sign-in retries this same effect.
      }
    })()
    return () => { cancelled = true }
    // Fires on identity change, not on every local pick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, user?.nativeLanguage, user?.isGuest])

  const setNativeLanguage = useCallback((code: string) => {
    if (!isSupported(code)) return
    setNativeState(code)
    setConfirmedOwner(ownerId)
    AsyncStorage.multiSet([[NATIVE_KEY, code], [CONFIRMED_KEY, ownerId]]).catch(() => {})
    // Local → server: persist for anyone holding a session — guests too. The
    // guest's row survives registration in place (`AuthService.RegisterWith…`
    // promotes the same row and never touches NativeLanguage), so this is the
    // step that carries the answer into the account they eventually create.
    if (user) {
      ;(async () => {
        try {
          const token = await getAccessToken()
          if (!token) return
          const res = await authApi.updateProfile(user.name ?? null, token, code)
          if (res?.user) await updateUser(res.user)
        } catch {
          // Keep the local value; the next login's server→local mirror reconciles.
        }
      })()
    }
  }, [user, getAccessToken, updateUser])

  return (
    <NativeLanguageContext.Provider value={{
      nativeLanguage, setNativeLanguage, hasConfirmedLanguage,
    }}>
      {children}
    </NativeLanguageContext.Provider>
  )
}

export function useNativeLanguage() {
  return useContext(NativeLanguageContext)
}
