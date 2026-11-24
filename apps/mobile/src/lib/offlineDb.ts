import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'

/** The SQLite database that held an upload's legacy chapter rows (`user_chapters`, `cached_user_books`). */
const OFFLINE_DB = 'textstack-offline'

/**
 * Deletes the legacy chapter cache (#1522): the V2 reader reads the book's file, never these rows, and
 * nothing writes them any more. Their text is one account's private book, so an install that still has
 * the database loses it on its next start rather than keeping it past a sign-out. Opened and closed
 * first: the close checkpoints and removes the WAL, so its pages go with the file. No file: nothing to do.
 */
export async function dropChapterCache(): Promise<void> {
  if (Platform.OS === 'web') return
  const { File, Paths } = require('expo-file-system') as typeof import('expo-file-system')
  if (!new File(Paths.document, 'SQLite', OFFLINE_DB).exists) return
  const SQLite = require('expo-sqlite') as typeof import('expo-sqlite')
  await (await SQLite.openDatabaseAsync(OFFLINE_DB)).closeAsync()
  await SQLite.deleteDatabaseAsync(OFFLINE_DB)
}

/**
 * Deletes the PDF originals cache (#1527): Download keeps the book's file in the V2 library now (#1522) and
 * nothing writes `<documents>/originals/` any more. An install from an older build loses it, its last-used
 * index and the deleted-on-server marks (they only ever named stored originals) on its next start.
 */
export async function dropOriginalsCache(): Promise<void> {
  if (Platform.OS === 'web') return
  const { Directory, Paths } = require('expo-file-system') as typeof import('expo-file-system')
  const originals = new Directory(Paths.document, 'originals')
  if (originals.exists) originals.delete()
  await AsyncStorage.multiRemove(['originals:lastUsed', 'offline:deletedOnServer'])
}
