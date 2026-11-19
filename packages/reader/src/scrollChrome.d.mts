export type ReaderScroll = { section: number; offset: number }
export function readReaderScroll(raw: unknown): ReaderScroll | null
export function createScrollIntent(threshold?: number): { reset(): void; move(next: ReaderScroll, suppressed?: boolean): 'show' | 'hide' | null }
