// Types for lightbox.mjs (#1265); a change to one must update the other.
export type Zoom = { s: number; x: number; y: number }
export type ZoomBox = { w: number; h: number; iw: number; ih: number }
export const MAX_SCALE: number
export const DOUBLE_TAP_SCALE: number
export function imageAt(target: unknown): { src: string; alt: string } | null
export function clampScale(s: number): number
export function clampPan(t: Zoom, size: ZoomBox): Zoom
export function zoomAt(from: Zoom, s: number, f0: { x: number; y: number }, f1: { x: number; y: number }, size: ZoomBox): Zoom
export type LightboxLabels = { image: string; close: string }
export const DEFAULT_LABELS: LightboxLabels
export const MAX_LABEL: number
export function readLabels(l: unknown, was?: LightboxLabels): LightboxLabels
export function createLightbox(doc: Document, post: (m: { type: 'lightbox'; open: boolean }) => void, behind?: () => Element | null):
  { open(img: { src: string; alt: string }, from?: Element | null): void; close(): void; labels(l: unknown): void }
