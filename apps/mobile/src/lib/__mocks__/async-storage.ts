/**
 * In-process AsyncStorage mock for Vitest unit tests.
 *
 * Wired via `vitest.config.ts` resolve.alias — anything that imports
 * `@react-native-async-storage/async-storage` in test runs gets this
 * instead. Mirrors the real API surface that our `lib/` code uses today
 * (setItem / getItem / removeItem / getAllKeys / multiGet / multiRemove).
 *
 * Not exposed at runtime — only loaded when the alias fires.
 *
 * Tests that need to reset state between cases can call `__reset()` from
 * the default export (e.g. in `beforeEach`).
 */

const store = new Map<string, string>()

const AsyncStorage = {
  async getItem(key: string): Promise<string | null> {
    return store.has(key) ? store.get(key)! : null
  },
  async setItem(key: string, value: string): Promise<void> {
    store.set(key, value)
  },
  /** Shallow JSON merge, like the native module's. */
  async mergeItem(key: string, value: string): Promise<void> {
    const prev = store.has(key) ? JSON.parse(store.get(key)!) : {}
    store.set(key, JSON.stringify({ ...prev, ...JSON.parse(value) }))
  },
  async removeItem(key: string): Promise<void> {
    store.delete(key)
  },
  async getAllKeys(): Promise<readonly string[]> {
    return Array.from(store.keys())
  },
  async multiGet(keys: readonly string[]): Promise<readonly [string, string | null][]> {
    return keys.map(k => [k, store.has(k) ? store.get(k)! : null])
  },
  async multiRemove(keys: readonly string[]): Promise<void> {
    for (const k of keys) store.delete(k)
  },
  async clear(): Promise<void> {
    store.clear()
  },
  /** Test-only: wipe the in-memory store between cases. */
  __reset(): void {
    store.clear()
  },
}

export default AsyncStorage
