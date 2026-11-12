import { Linking } from 'react-native'

const PACKAGE = 'app.textstack.mobile'

/** An app's page in the Play Store app, else on the Play website (no Play Store installed). */
export function openPlayStorePage(id: string): void {
  Linking.openURL(`market://details?id=${id}`).catch(() => {
    Linking.openURL(`https://play.google.com/store/apps/details?id=${id}`).catch(() => {})
  })
}

/** TextStack's own page. No argument on purpose: it is passed straight to `onPress`. */
export function openPlayStore(): void {
  openPlayStorePage(PACKAGE)
}
