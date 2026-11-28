// The Expo modules the copied code calls, with the same names and shapes, over WebView and Capacitor APIs. So a copy
// changes only its import line.

/** `@react-native-async-storage/async-storage`'s calls, over the WebView's localStorage (kept with the app's data). */
export const AsyncStorage = {
  getItem: async (key: string): Promise<string | null> => localStorage.getItem(key),
  setItem: async (key: string, value: string): Promise<void> => localStorage.setItem(key, value),
  removeItem: async (key: string): Promise<void> => localStorage.removeItem(key),
}

/** `expo-secure-store`'s calls, over `@aparajita/capacitor-secure-storage` (Android Keystore). Loaded on first use. */
// The module, never the plugin: a promise resolved with a Capacitor plugin proxy calls its `then` (not a method).
const secureModule = () => import('@aparajita/capacitor-secure-storage')
export const SecureStore = {
  getItemAsync: async (key: string): Promise<string | null> => (await secureModule()).SecureStorage.getItem(key),
  setItemAsync: async (key: string, value: string): Promise<void> => (await secureModule()).SecureStorage.setItem(key, value),
  deleteItemAsync: async (key: string): Promise<void> => (await secureModule()).SecureStorage.removeItem(key),
}

/** `expo-modules-core`'s `uuid`. */
export const uuid = { v4: (): string => crypto.randomUUID() }

type NetState = { isConnected: boolean | null; isInternetReachable: boolean | null }
const netState = (connected: boolean): NetState => ({ isConnected: connected, isInternetReachable: connected })

/**
 * `@react-native-community/netinfo`'s listener, over `@capacitor/network` (the WebView's own `online` event needs a
 * permission the shell may not have). As NetInfo does, the listener is called once with the current state on subscribe.
 */
export const NetInfo = {
  addEventListener(listener: (s: NetState) => void): () => void {
    let removed = false
    const handle = import('@capacitor/network').then(async ({ Network }) => {
      const h = await Network.addListener('networkStatusChange', (s) => listener(netState(s.connected)))
      const now = await Network.getStatus()
      if (!removed) listener(netState(now.connected))
      return h
    })
    handle.catch(() => {})
    return () => {
      removed = true
      void handle.then((h) => h.remove(), () => {})
    }
  },
}

/**
 * A device file (`file://`) as a `Blob`, read through the WebView (`Capacitor.convertFileSrc`): the stand-in for
 * expo-file-system's `FileHandle`. A missing or unreadable file is an error.
 */
export async function deviceFileBlob(uri: string): Promise<Blob> {
  const { Capacitor } = await import('@capacitor/core')
  const res = await fetch(Capacitor.convertFileSrc(uri))
  if (!res.ok) throw new Error(`device file not readable (${res.status})`)
  return res.blob()
}
