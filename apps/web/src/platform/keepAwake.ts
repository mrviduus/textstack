/**
 * The screen stays on until the returned function is called (the Screen Wake Lock API, on the web and in the
 * Android WebView alike). The browser drops the lock when the page is hidden, so it is taken again when the
 * page shows. No API or a refusal (battery saver): the screen dims as usual.
 */
// ponytail: a WebView without the API (before 2024) does not keep the screen on; a native
// FLAG_KEEP_SCREEN_ON plugin in apps/android is the upgrade if such devices matter.
export function keepAwake(): () => void {
  let lock: WakeLockSentinel | null = null
  let asking = false
  let off = false
  const take = () => {
    // One lock at a time: none is asked for while a request is open or a lock is held.
    if (!navigator.wakeLock || off || asking || (lock && !lock.released) || document.visibilityState !== 'visible') return
    asking = true
    navigator.wakeLock.request('screen').then((l) => {
      asking = false
      if (off) void l.release().catch(() => {})
      else lock = l
    }, () => { asking = false })
  }
  take()
  document.addEventListener('visibilitychange', take)
  return () => {
    off = true
    document.removeEventListener('visibilitychange', take)
    void lock?.release().catch(() => {})
  }
}
