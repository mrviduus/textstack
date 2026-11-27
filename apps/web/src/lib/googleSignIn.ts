/**
 * Google sign-in on the web: Google Identity Services (GIS), moved from `AuthContext`. The script loads once,
 * and each sign-in gives the Google id token to `onIdToken`.
 * Resolves false when there is no client id (`VITE_GOOGLE_CLIENT_ID`) or GIS did not load.
 */
export async function initGoogleSignIn(onIdToken: (idToken: string) => void): Promise<boolean> {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID
  if (!clientId) return false
  if (!document.getElementById('google-signin-script')) {
    await new Promise<void>((resolve, reject) => {
      const script = document.createElement('script')
      script.id = 'google-signin-script'
      script.src = 'https://accounts.google.com/gsi/client'
      script.async = true
      script.defer = true
      script.onload = () => resolve()
      script.onerror = () => reject(new Error('Failed to load Google Sign-In'))
      document.head.appendChild(script)
    })
  }
  if (typeof google === 'undefined' || !google.accounts?.id) return false
  google.accounts.id.initialize({
    client_id: clientId,
    callback: (response) => onIdToken(response.credential),
    auto_select: false,
    cancel_on_tap_outside: true,
  })
  return true
}

/** GIS's own button, drawn once into `el`. */
export function renderGoogleButton(el: HTMLElement) {
  if (el.hasChildNodes()) return
  if (typeof google !== 'undefined' && google.accounts?.id) {
    google.accounts.id.renderButton(el, { type: 'standard', theme: 'outline', size: 'large', width: 300, text: 'continue_with' })
  }
}

/** After sign-out or account deletion: the next sign-in does not pick the account by itself. */
export function signOutOfGoogle() {
  if (typeof google !== 'undefined') google.accounts.id.disableAutoSelect()
}
