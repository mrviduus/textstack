// Types for lightbox.mjs (#1265); a change to one must update the other.
export const MAX_SCALE: number
export const DOUBLE_TAP_SCALE: number
export function imageAt(target: unknown): { src: string; alt: string } | null
export function clampScale(s: number): number
export function createLightbox(doc: Document, post: (m: { type: 'lightbox'; open: boolean }) => void, behind?: () => Element | null):
  { open(img: { src: string; alt: string }, from?: Element | null): void; close(): void; isOpen(): boolean }
