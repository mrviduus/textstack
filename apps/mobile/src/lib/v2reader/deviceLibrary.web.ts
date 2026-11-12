// Web twin of deviceLibrary.ts: no V2 local library in the web bundle (no expo-sqlite there). Never
// reached: sync.ts's `adoptV2LocalAccount` returns on web before asking for it, and the V2 reader
// screen is Android-only. The storage and sign-out exports have nothing to measure or wipe here.
import { NOTHING_LOST, type LocalLibrary, type SignOutLoss } from './localLibrary'

export function deviceLocalLibrary(): LocalLibrary {
  throw new Error('The V2 local library is Android-only')
}

export const deviceV2Bytes = (): number => 0
export const deviceV2SignOutLoss = async (): Promise<SignOutLoss> => NOTHING_LOST
export const wipeDeviceV2Library = async (): Promise<void> => {}
