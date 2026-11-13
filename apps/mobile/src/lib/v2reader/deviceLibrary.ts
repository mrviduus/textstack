// The device's V2 local library over expo-sqlite (R6), and its files under <documents>/v2/.
// deviceLibrary.web.ts is its twin: the web bundle (which mobile e2e runs against) must never resolve
// expo-sqlite from here.
import { createLocalLibrary, wipeV2Library, type Db, type LocalLibrary, type SignOutLoss } from './localLibrary'

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
export const v2Root = () => new (fs().Directory)(fs().Paths.document, 'v2')

/** The host's directories under the root, made when missing. */
export function makeV2Dirs() {
  for (const dir of ['books', 'store', 'staging']) new (fs().Directory)(v2Root(), dir).create({ intermediates: true, idempotent: true })
}

/**
 * Everything under the root deleted, its directories made again whenever this ran (a failure of either
 * step is retried whole by the next call) so the host's next write finds them: the one place the
 * files are wiped. A wipe may create the three empty directories; measuring never does.
 */
export function clearV2Files() {
  const root = v2Root()
  try {
    if (root.exists) root.delete()
  } finally {
    makeV2Dirs()
  }
}

/** Bytes under the root (book files, staging); 0 when it never existed. Creates nothing; never throws. */
export function deviceV2Bytes(): number {
  try {
    // Null when the directory does not exist.
    return v2Root().size ?? 0
  } catch {
    return 0
  }
}

/** What signing out would delete that the server does not hold (#1070). */
export const deviceV2SignOutLoss = (): Promise<SignOutLoss> => deviceLocalLibrary().signOutLoss()

/** Sign-out (#1070, owner 2026-11-12: V2 books belong to the account): rows, then files (`wipeV2Library`). */
export const wipeDeviceV2Library = (): Promise<void> => wipeV2Library(deviceLocalLibrary(), clearV2Files)
