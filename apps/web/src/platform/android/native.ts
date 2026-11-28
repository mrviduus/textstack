// The Expo modules the copied code calls, with the same names and shapes, over WebView APIs. So a copy changes only
// its import line. Tests use the real ones under jsdom (localStorage, crypto, window events).

/** `@react-native-async-storage/async-storage`'s calls, over the WebView's localStorage (kept with the app's data). */
export const AsyncStorage = {
  getItem: async (key: string): Promise<string | null> => localStorage.getItem(key),
  setItem: async (key: string, value: string): Promise<void> => localStorage.setItem(key, value),
  removeItem: async (key: string): Promise<void> => localStorage.removeItem(key),
}

/** `expo-modules-core`'s `uuid`. */
export const uuid = { v4: (): string => crypto.randomUUID() }

type NetState = { isConnected: boolean | null; isInternetReachable: boolean | null }

/** `@react-native-community/netinfo`'s listener, over the WebView's `online` event (it fires only when the network is back). */
export const NetInfo = {
  addEventListener(listener: (s: NetState) => void): () => void {
    const online = () => listener({ isConnected: true, isInternetReachable: true })
    window.addEventListener('online', online)
    return () => window.removeEventListener('online', online)
  },
}
