// What should the reader see of an over-the-air update?
//
// AutoUpdater (with updateApply.ts) checks, downloads and restarts on its own.
// Done silently, the app just blinks and comes back — which reads as a crash.
// So: a thin bar while it downloads, a word before the restart, a toast after.
//
// In the reader the download bar stays hidden: it would sit over the text for
// as long as the download takes, and the restart is deferred there anyway.
// The reader gets one short notice when the update is ready instead.

import { isReading } from './updateApply'

export type UpdateBannerState =
  | { kind: 'none' }
  | { kind: 'downloading'; progress?: number }
  | { kind: 'ready-in-reader' }
  | { kind: 'restarting' }

export type UpdateBannerInput = {
  /** Metro build, web, or expo-updates disabled — nothing to show. */
  isDev: boolean
  isDownloading: boolean
  /** 0..1 from expo-updates; undefined when unknown. */
  downloadProgress?: number
  isUpdatePending: boolean
  pathname: string
  /** AutoUpdater is about to call reloadAsync. */
  restarting: boolean
}

export function updateBannerState(s: UpdateBannerInput): UpdateBannerState {
  if (s.isDev) return { kind: 'none' }
  if (s.restarting) return { kind: 'restarting' }
  const reading = isReading(s.pathname)
  if (s.isDownloading && !reading) {
    const p = s.downloadProgress
    return typeof p === 'number' && Number.isFinite(p)
      ? { kind: 'downloading', progress: Math.min(1, Math.max(0, p)) }
      : { kind: 'downloading' }
  }
  if (s.isUpdatePending && reading) return { kind: 'ready-in-reader' }
  return { kind: 'none' }
}

/**
 * Toast "TextStack updated" after a launch that runs a new OTA bundle.
 * No stored id yet means first run after install (or the first run of this
 * code) — remember silently, there is nothing the reader would recognise as new.
 */
export function shouldAnnounceUpdate(
  lastSeenId: string | null,
  currentId: string | null,
  isEmbeddedLaunch: boolean,
  isDev: boolean,
): boolean {
  if (isDev || isEmbeddedLaunch || !currentId || !lastSeenId) return false
  return lastSeenId !== currentId
}

// "Restarting" lives outside React's tree: AutoUpdater sets it, UpdateBanner
// reads it via useSyncExternalStore. A context would be more ceremony for one bit.
let restarting = false
const listeners = new Set<() => void>()

export const restartStore = {
  get: () => restarting,
  set(v: boolean) {
    restarting = v
    listeners.forEach(l => l())
  },
  subscribe(l: () => void) {
    listeners.add(l)
    return () => { listeners.delete(l) }
  },
}
