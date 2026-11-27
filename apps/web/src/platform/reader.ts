/**
 * The reader route's part of the platform seam (see `index.ts`). A module of its own: only the reader's lazy
 * chunk imports it, so the sync code stays out of the library route's bundle. `vite.config.ts` resolves
 * `@platform-target/reader` to `<target>.reader.ts`.
 */
import type { HostBook } from '../components/reader/ReaderHost'
import type { createReaderSync } from '../lib/readerSync'
import type { flushPendingSessions, queueReadingSession } from '../hooks/useReadingSession'

export interface ReaderPlatform {
  /** Settles when a book can be opened. Web: the session is settled and the server probe answered. */
  ready(): Promise<unknown>
  /** True when `ready()` has settled already: the route then shows the reader at once. */
  readyNow(): boolean
  /**
   * The book's bytes and what the reader syncs. Null: the book has no readable file.
   * `onActivity` runs at each step and chunk (the route's stall timer). `onPercent` is the download, 0–99.
   */
  openBook(id: string, o: { signal: AbortSignal; onActivity(): void; onPercent(percent: number): void }): Promise<HostBook | null>
  /** The sync session of one open book. Web: `lib/readerSync.ts`, the server. Android: the local store and its outbox. */
  createSync: typeof createReaderSync
  /** Keeps a finished reading session until it is sent. Web: a queue in `localStorage`, sent to the server. */
  queueSession: typeof queueReadingSession
  /** Sends the queued reading sessions. */
  flushSessions: typeof flushPendingSessions
  /** Changes when the account store resets (sign-out, another account): an answer from before it is dropped. */
  accountEpoch(): number
}

/** Part of the reader sync contract: `complete` rejects with this message when the server has no place of this file yet. */
export const NO_PLACE_YET = 'no reading state on this file yet'

export { reader } from '@platform-target/reader'
