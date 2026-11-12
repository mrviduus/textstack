// The device's V2 local library over expo-sqlite (R6). deviceLibrary.web.ts is its twin: the web
// bundle (which mobile e2e runs against) must never resolve expo-sqlite from here.
import { createLocalLibrary, NOTHING_LOST, type Db, type LocalLibrary, type SignOutLoss } from './localLibrary'

const DB_NAME = 'textstack-v2'

let device: LocalLibrary | null = null
let opened: Promise<any> | null = null

/** The open database; a failed open is not kept, so the next call tries again (the offline reading path depends on it). */
function database(): Promise<any> {
  return (opened ??= (require('expo-sqlite') as typeof import('expo-sqlite')).openDatabaseAsync(DB_NAME).catch((e: unknown) => {
    opened = null
    throw e
  }))
}

/** The device's library, opened on first use. */
export function deviceLocalLibrary(): LocalLibrary {
  const later = <K extends keyof Db>(k: K) => (async (...args: unknown[]) => (await database())[k](...args)) as Db[K]
  return (device ??= createLocalLibrary({
    execAsync: later('execAsync'),
    runAsync: later('runAsync'),
    getFirstAsync: later('getFirstAsync'),
    getAllAsync: later('getAllAsync'),
    withTransactionAsync: later('withTransactionAsync'),
  }))
}

const fs = () => require('expo-file-system') as typeof import('expo-file-system')
/** `<documents>/v2/`: the host's files (hostStorage.ts). Built on use: expo-file-system web has no paths. */
const v2Directory = () => new (fs().Directory)(fs().Paths.document, 'v2')
/**
 * Whether the database was ever created. Opening it creates it, so a dev route never visited (the
 * reader is `__DEV__`-only) must stay unopened: measuring and the sign-out check never create it.
 */
const databaseExists = () => opened !== null || new (fs().File)(fs().Paths.document, 'SQLite', DB_NAME).exists

/** Bytes under `<documents>/v2/` (book files, staging); 0 when it was never created. Never throws. */
export function deviceV2Bytes(): number {
  try {
    // Null when the directory does not exist; reading it creates nothing.
    return v2Directory().size ?? 0
  } catch {
    return 0
  }
}

/** What signing out would delete that the server does not hold (#1070); nothing when the library was never created. */
export async function deviceV2SignOutLoss(): Promise<SignOutLoss> {
  return databaseExists() ? deviceLocalLibrary().signOutLoss() : NOTHING_LOST
}

/**
 * Sign-out (#1070, owner 2026-11-12: V2 books belong to the account): every row (books, reading
 * state, highlights, outbox, cursors) and every file under `<documents>/v2/`. Rows first: a failed
 * file delete leaves bytes nobody lists, never a row naming a missing file. Every step is tried; any
 * failure is thrown afterwards for the caller to report. Nothing that was never created is created.
 */
export async function wipeDeviceV2Library(): Promise<void> {
  const errors: unknown[] = []
  try {
    if (databaseExists()) await deviceLocalLibrary().wipe()
  } catch (e) {
    errors.push(e)
  }
  try {
    const dir = v2Directory()
    if (dir.exists) dir.delete()
  } catch (e) {
    errors.push(e)
  }
  if (errors.length) throw new Error(`V2 library not fully wiped: ${errors.map((e) => (e as Error)?.message ?? String(e)).join('; ')}`)
}
