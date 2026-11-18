// Types for movedTracker.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export interface MovedTracker {
  open(): void
  restored(): void
  relocate(r: { index: number | null; moved: boolean } | null): void
  hostMove(): void
  /** `decideServerState`'s `reader` (`OpenReader`, packages/shared v2LocalSync.ts). */
  reader(): { restoreApplied: boolean; moved: boolean; index: number | null }
}
export function createMovedTracker(): MovedTracker
