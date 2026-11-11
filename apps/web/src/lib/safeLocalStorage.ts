// localStorage that never throws: a full, disabled or cleared storage costs the value, never the caller's work.
export function readItem(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeItem(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch (e) {
    console.warn(`[storage] localStorage write ${key} failed: ${e}`)
  }
}
