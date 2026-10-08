import AsyncStorage from '@react-native-async-storage/async-storage'

/**
 * Catalog books the reader took out of the library on this device. Two things add a book without a
 * tap — downloading it and reading 1% of it — and neither may put back a book the reader removed.
 * Cleared again when the reader adds it explicitly. Device-local on purpose: no server field exists
 * for "removed", and web has no auto-add that could disagree.
 */
const KEY = 'textstack_library_removed'
const MAX = 500 // ponytail: oldest dropped past this; a reader who removes 500 books gets one re-add

async function read(): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(KEY)
    const v = raw ? JSON.parse(raw) : []
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

export async function wasLibraryRemoved(editionId: string): Promise<boolean> {
  return (await read()).includes(editionId)
}

export async function markLibraryRemoved(editionId: string): Promise<void> {
  const ids = (await read()).filter(id => id !== editionId)
  ids.push(editionId)
  await AsyncStorage.setItem(KEY, JSON.stringify(ids.slice(-MAX))).catch(() => {})
}

export async function clearLibraryRemoved(editionId: string): Promise<void> {
  const ids = await read()
  if (!ids.includes(editionId)) return
  await AsyncStorage.setItem(KEY, JSON.stringify(ids.filter(id => id !== editionId))).catch(() => {})
}
