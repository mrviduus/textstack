/**
 * NetInfo for Vitest (wired by `vitest.config.ts` resolve.alias): the native module pulls in
 * react-native. Listeners are kept; a test fires a connectivity change with `__emit`.
 */
type State = { isConnected: boolean | null; isInternetReachable: boolean | null }
type Listener = (s: State) => void

const listeners = new Set<Listener>()

const NetInfo = {
  addEventListener(l: Listener) {
    listeners.add(l)
    return () => { listeners.delete(l) }
  },
  fetch: async (): Promise<State> => ({ isConnected: true, isInternetReachable: true }),
  __emit(s: State) {
    for (const l of listeners) l(s)
  },
}

export default NetInfo
