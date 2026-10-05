import { useCallback, useEffect, useRef } from 'react'
import { AppState, type AppStateStatus } from 'react-native'
import { usePathname } from 'expo-router'
import * as Updates from 'expo-updates'
import { shouldApplyUpdate } from '../lib/updateApply'
import { restartStore } from '../lib/updateBanner'

// Long enough to read "Restarting…" so the blink has a reason, short enough
// not to feel like a wait.
const RESTART_NOTICE_MS = 800

/**
 * Applies an over-the-air update as soon as it is safe to, instead of on the
 * second cold start.
 *
 * The default is two launches: `fallbackToCacheTimeout: 0` means the app never
 * waits at the splash screen, so launch one downloads and launch two runs the
 * new bundle. Nobody restarts an app twice to collect a fix — the update simply
 * arrives days later, or whenever the phone reboots.
 *
 * Raising `fallbackToCacheTimeout` would fix that at the splash screen, at the
 * price of blocking every launch on the network — and it lives in app.json, a
 * fingerprint input, so shipping it would need a store build. This is JS, so it
 * travels as an update itself.
 *
 * The one thing it will not do is restart mid-chapter. See updateApply.ts.
 */
export function AutoUpdater() {
  const { isUpdatePending } = Updates.useUpdates()
  const pathname = usePathname()
  // reloadAsync tears the tree down, but its promise resolves before that
  // finishes — without this, a second trigger fires another reload into the
  // teardown.
  const reloading = useRef(false)

  const routeRef = useRef(pathname)
  routeRef.current = pathname

  const apply = useCallback(async (pending: boolean, route: string) => {
    if (reloading.current) return
    if (!shouldApplyUpdate({ isUpdatePending: pending, isDev: __DEV__, pathname: route })) return
    reloading.current = true
    try {
      restartStore.set(true)
      await new Promise(r => setTimeout(r, RESTART_NOTICE_MS))
      // They may have opened a chapter during the notice. Same rule as above, on the
      // route they are on NOW; the pathname effect applies it once they leave.
      if (!shouldApplyUpdate({ isUpdatePending: pending, isDev: __DEV__, pathname: routeRef.current })) {
        restartStore.set(false)
        reloading.current = false
        return
      }
      await Updates.reloadAsync()
    } catch {
      restartStore.set(false)
      // A failed reload is not worth surfacing. The update is downloaded, and
      // the next launch uses it regardless — which is the old behaviour.
      reloading.current = false
    }
  }, [])

  // Ask the server. Runs at startup and whenever the app returns to the
  // foreground, which is when anything published in the meantime shows up.
  const check = useCallback(async (route: string) => {
    try {
      const result = await Updates.checkForUpdateAsync()
      if (!result.isAvailable) return
      const fetched = await Updates.fetchUpdateAsync()
      await apply(fetched.isNew, route)
    } catch {
      // Offline, or the update server is unreachable. Nothing to say to the
      // user: they did not ask for this, and the app works either way.
    }
  }, [apply])

  useEffect(() => {
    if (__DEV__) return
    void check(routeRef.current)
    const sub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') void check(routeRef.current)
    })
    return () => sub.remove()
  }, [check])

  // The deferral above is only half a rule. An update that arrived while the
  // user was reading has to land when they leave the reader, or "wait" becomes
  // "never" for whoever reads in one long session.
  useEffect(() => {
    if (__DEV__) return
    void apply(isUpdatePending, pathname)
  }, [apply, isUpdatePending, pathname])

  return null
}
