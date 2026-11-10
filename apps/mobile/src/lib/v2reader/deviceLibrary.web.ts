// Web twin of deviceLibrary.ts: no V2 local library in the web bundle (no expo-sqlite there). Never
// reached: sync.ts's `adoptV2LocalAccount` returns on web before asking for it, and the V2 reader
// screen is Android-only.
import type { LocalLibrary } from './localLibrary'

export function deviceLocalLibrary(): LocalLibrary {
  throw new Error('The V2 local library is Android-only')
}
