// Types for chrome.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export type Flow = 'paginated' | 'scrolled'
export type TapAction = 'prev' | 'next' | 'toggle' | 'none'
export const EDGE: number
export const LONG_PRESS_MS: number
export const PAIR_MS: number
export const BAR_PRESS_GRACE_MS: number
export function tapAction(input: { kind: string; x: number | null; width: number; flow: Flow | null; selection?: boolean; rtl?: boolean }): TapAction
export interface TouchTracker {
  start(x: number, at: number): void
  end(x: number, at: number): void
  take(at: number): { x: number | null; selection: boolean }
}
export function createTouchTracker(): TouchTracker
export function hidesBarsOnRelocate(input: { flow: Flow | null; moved: boolean; msSinceBarPress: number }): boolean
export function backAction(input: { offer: boolean; reading: boolean }): 'close-offer' | 'close-book' | 'leave'
