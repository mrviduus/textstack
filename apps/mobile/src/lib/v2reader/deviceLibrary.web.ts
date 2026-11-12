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

export const v2Root = androidOnly
export const makeV2Dirs = (): void => {}
export const clearV2Files = (): void => {}
export const deviceV2Bytes = (): number => 0
export const deviceV2SignOutLoss = async (): Promise<SignOutLoss> => NOTHING_LOST
export const wipeDeviceV2Library = async (): Promise<void> => {}
