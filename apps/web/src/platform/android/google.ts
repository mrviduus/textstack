// The seam's `google` on Android: the native Google sign-in (@capgo/capacitor-social-login), not GIS. The id token
// goes to the same `onIdToken` as on the web; `account.loginWithGoogle` exchanges it in mobile mode.
import type { Platform } from '../index'

// The module, never the plugin: a promise resolved with a Capacitor plugin proxy calls its `then` (not a method).
const plugin = () => import('@capgo/capacitor-social-login')
let onToken: ((idToken: string) => void) | null = null

/** The native sign-in; its id token to `onToken`. A cancel or a failure only warns (the reader taps again). */
async function signIn() {
  try {
    const r = await (await plugin()).SocialLogin.login({ provider: 'google', options: {} })
    const idToken = (r.result as { idToken?: string | null }).idToken
    if (idToken) onToken?.(idToken)
  } catch (e) {
    console.warn('[google] sign-in did not finish:', (e as Error | null)?.message)
  }
}

export const google: Platform['google'] = {
  /** False when there is no web client id (`VITE_GOOGLE_CLIENT_ID`, the id the server checks the token against) or the plugin fails. */
  async init(onIdToken) {
    const webClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
    if (!webClientId) return false
    onToken = onIdToken
    return (await plugin()).SocialLogin.initialize({ google: { webClientId } }).then(() => true, () => false)
  },
  /** A plain button, drawn once into `el` (GIS draws its own on the web). */
  renderButton(el) {
    if (el.hasChildNodes()) return
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'google-native-button'
    button.textContent = 'Continue with Google'
    button.addEventListener('click', () => void signIn())
    el.appendChild(button)
  },
  /** The next sign-in shows the account picker again. */
  signOut() {
    void plugin().then((m) => m.SocialLogin.logout({ provider: 'google' })).catch(() => {})
  },
}
