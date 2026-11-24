// The device's V2 local library over expo-sqlite (R6), and its files under <documents>/v2/.
// deviceLibrary.web.ts is its twin: the web bundle (which mobile e2e runs against) must never resolve
// expo-sqlite from here.
import { createLocalLibrary, wipeLibrary, type Db, type LocalLibrary, type SignOutLoss } from './localLibrary'

let device: LocalLibrary | null = null
let opened: Promise<any> | null = null

/** The open database; a failed open is not kept, so the next call tries again (the offline reading path depends on it). */
function database(): Promise<any> {
  return (opened ??= (require('expo-sqlite') as typeof import('expo-sqlite')).openDatabaseAsync('textstack-v2').catch((e: unknown) => {
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
export const filesRoot = () => new (fs().Directory)(fs().Paths.document, 'v2')

/** The host's directories under the root, made when missing. */
export function makeFileDirs() {
  for (const dir of ['books', 'store', 'staging']) new (fs().Directory)(filesRoot(), dir).create({ intermediates: true, idempotent: true })
}

/**
 * When this process started, as far as staging can tell: every staged name (`staging/<ms>.epub`,
 * `staging/dl-<ms>.epub`) is written by code that imports this module, so its `Date.now()` is never earlier.
 */
const STARTED = Date.now()

/**
 * #1526: what an earlier process left in `staging/` (an open, download or upload it never finished) deleted;
 * this process's own entries are live (a Download or an upload still writing) and stay. An entry whose name
 * carries no time is an earlier build's: deleted. ponytail: wall-clock based; a clock set back mid-process
 * only leaves a stale file for the next start.
 */
export function sweepStaging() {
  const staging = new (fs().Directory)(filesRoot(), 'staging')
  if (!staging.exists) return
  for (const entry of staging.list()) {
    const ms = Number(/\d+/.exec(entry.name)?.[0])
    if (!(ms >= STARTED)) entry.delete()
  }
}

/**
 * Everything under the root deleted, its directories made again whenever this ran (a failure of either
 * step is retried whole by the next call) so the host's next write finds them: the one place the
 * files are wiped. A wipe may create the three empty directories; measuring never does.
 */
export function clearDeviceFiles() {
  const root = filesRoot()
  try {
    if (root.exists) root.delete()
  } finally {
    makeFileDirs()
  }
}

/** Bytes under the root (book files, staging); 0 when it never existed. Creates nothing; never throws. */
export function deviceLibraryBytes(): number {
  try {
    // Null when the directory does not exist.
    return filesRoot().size ?? 0
  } catch {
    return 0
  }
}

/** What signing out would delete that the server does not hold (#1070). */
export const deviceSignOutLoss = (): Promise<SignOutLoss> => deviceLocalLibrary().signOutLoss()

/** Sign-out (#1070, owner 2026-11-12: V2 books belong to the account): rows, then files (`wipeLibrary`). */
export const wipeDeviceLibrary = (): Promise<void> => wipeLibrary(deviceLocalLibrary(), clearDeviceFiles)
