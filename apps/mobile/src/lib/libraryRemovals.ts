import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * Catalog books the reader took out of the library, per account on this device. Two things add a
 * book without a tap — downloading it and reading 1% of it — and neither may put back a book the
 * reader removed. Cleared when the reader adds it explicitly. Keyed by user id, so a second account
 * on the phone starts clean (code review #781). No server field exists for "removed".
 */
const keyFor = (userId: string) => `textstack_library_removed:${userId}`
const MAX = 500 // ponytail: oldest dropped past this; a reader who removes 500 books gets one re-add

async function read(userId: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(keyFor(userId))
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

export async function wasLibraryRemoved(userId: string, editionId: string): Promise<boolean> {
  return (await read(userId)).includes(editionId)
}

export async function markLibraryRemoved(userId: string, editionId: string): Promise<void> {
  const ids = (await read(userId)).filter(id => id !== editionId)
  ids.push(editionId)
  await AsyncStorage.setItem(keyFor(userId), JSON.stringify(ids.slice(-MAX))).catch(() => {})
}

export async function clearLibraryRemoved(userId: string, editionId: string): Promise<void> {
  const ids = await read(userId)
  if (!ids.includes(editionId)) return
  await AsyncStorage.setItem(keyFor(userId), JSON.stringify(ids.filter(id => id !== editionId))).catch(() => {})
}
