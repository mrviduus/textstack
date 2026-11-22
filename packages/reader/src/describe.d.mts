// Types for describe.mjs (apps/web type-checks it without allowJs); a change to one must update the other.
export const MAX_META_TITLE: number
export const MAX_META_AUTHOR: number
export const MAX_META_LANG: number
export const MAX_META_DESCRIPTION: number
export const COVER_SIDE: number
export const MAX_COVER_SENT: number
export const MAX_COVER_BYTES: number
export function isRequestId(id: unknown): id is string
/** A book's details as read from its file; each '' when the file has none. */
export interface BookMeta { title: string; author: string; lang: string; description: string }
/** The `described` message as a host takes it. */
export interface Described {
  id: string
  /** null with `error`. */
  meta: BookMeta | null
  /** A `data:image/jpeg;base64,` URL, or null. */
  cover: string | null
  error?: string
}
export function bookMeta(metadata: unknown, ui?: string): BookMeta
export function coverJpeg(blob: Blob | null | undefined): Promise<string | null>
export function readDescribed(m: unknown): Described | null
