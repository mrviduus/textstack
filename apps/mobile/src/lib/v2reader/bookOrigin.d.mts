// Types for bookOrigin.mjs; a change to one must update the other.
export const BOOK_ORIGIN: string
export const BOOK_PATH: string
export const BOOK_CONNECT_SRC: string
export function bookUrl(file: string): string
export function servedFile(url: string): string | null
