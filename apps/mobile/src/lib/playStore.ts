import { Linking } from 'react-native'

const PACKAGE = 'app.textstack.mobile'
const PLAY_WEB_URL = `https://play.google.com/store/apps/details?id=${PACKAGE}`
const PLAY_APP_URL = `market://details?id=${PACKAGE}`

/** The Play Store app, else the Play website (no Play Store installed). */
export function openPlayStore(): void {
  Linking.openURL(PLAY_APP_URL).catch(() => {
    Linking.openURL(PLAY_WEB_URL).catch(() => {})
  })
}
