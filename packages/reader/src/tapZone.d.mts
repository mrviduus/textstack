// Types for tapZone.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export const EDGE_SHARE: number
export type TapAction = 'prev' | 'next' | 'toggle'
export function tapAction(tap: { x?: number; width?: number; flow: 'paginated' | 'scrolled'; dir?: 'ltr' | 'rtl' }): TapAction
