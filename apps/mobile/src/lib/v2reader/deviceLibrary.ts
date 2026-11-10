// The device's V2 local library over expo-sqlite (R6). deviceLibrary.web.ts is its twin: the web
// bundle (which mobile e2e runs against) must never resolve expo-sqlite from here.
import { createLocalLibrary, type Db, type LocalLibrary } from './localLibrary'

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
