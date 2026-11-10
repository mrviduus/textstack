// Web twin of deviceLibrary.ts: no V2 local library in the web bundle (no expo-sqlite there). Only
// reached if a caller ignores that: sync.ts's `adoptV2LocalAccount` returns before asking for it,
// since nothing on web ever records a synced identity.
import type { LocalLibrary } from './localLibrary'

export function deviceLocalLibrary(): LocalLibrary {
  throw new Error('The V2 local library is Android-only')
}
