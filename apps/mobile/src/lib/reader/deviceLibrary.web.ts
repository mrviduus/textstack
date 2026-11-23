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
export const clearDeviceFiles = (): void => {}
export const deviceLibraryBytes = (): number => 0
export const deviceSignOutLoss = async (): Promise<SignOutLoss> => NOTHING_LOST
export const wipeDeviceLibrary = async (): Promise<void> => {}
