import type { ReaderPlatform } from './reader'
import { syncAnswer, syncStore, syncSwitch } from '../api/sync'
import { openBook } from '../lib/openBook'
import { createReaderSync } from '../lib/readerSync'
import { flushPendingSessions, queueReadingSession } from '../hooks/useReadingSession'

/** The web reader: the book's bytes and its sync come from the server. */
export const reader: ReaderPlatform = {
  ready: () => syncSwitch(),
  readyNow: () => syncAnswer() !== null,
  openBook: (id, o) => openBook(id, o),
  createSync: (t, o) => createReaderSync(t, o),
  queueSession: (session) => queueReadingSession(session),
  flushSessions: () => flushPendingSessions(),
  accountEpoch: () => syncStore.epoch,
}
