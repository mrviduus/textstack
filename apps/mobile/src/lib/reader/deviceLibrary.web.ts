// Web twin of deviceLibrary.ts: no V2 local library in the web bundle (no expo-sqlite there). Never
// reached: sync.ts returns on web before asking for it, and the V2 reader screen is Android-only.
// Every export is mirrored; the storage and sign-out ones have nothing to measure or wipe here.
import { NOTHING_LOST, type LocalLibrary, type SignOutLoss } from './localLibrary'

const androidOnly = (): never => {
  throw new Error('The V2 local library is Android-only')
}

export function deviceLocalLibrary(): LocalLibrary {
  return androidOnly()
}

export const filesRoot = androidOnly
export const makeFileDirs = (): void => {}
export const sweepStaging = (): void => {}
export const clearDeviceFiles = (): void => {}
export const deviceLibraryBytes = (): number => 0
export const deviceSignOutLoss = async (): Promise<SignOutLoss> => NOTHING_LOST
export const deviceOwnedLoss = async (): Promise<SignOutLoss | 'unknown' | null> => null
export const wipeDeviceLibrary = async (): Promise<void> => {}
export const LIBRARY_WIPE_MS = 5000
export const clearWipePending = async (): Promise<void> => {}
export const signedOutMayList = async (): Promise<boolean> => true
export const deviceRemovals = async (): Promise<Set<string>> => new Set()
