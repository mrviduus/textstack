import { isOfflineError } from '@textstack/shared'

/** Offline is an expected state on load paths; a red LogBox for it masks real errors (#1156). */
export function logLoadError(label: string, e: unknown): void {
  ;(isOfflineError(e) ? console.warn : console.error)(label, e)
}
