import type { ReaderPlatform } from './reader'
import { notYet } from './android'

/** The Android reader (ADR-035): the retained file on the device and the local store. Wave 5 (#1642). */
export const reader: ReaderPlatform = {
  ready: notYet('reader.ready'),
  readyNow: notYet('reader.readyNow'),
  openBook: notYet('reader.openBook'),
  createSync: notYet('reader.createSync'),
  queueSession: notYet('reader.queueSession'),
  flushSessions: notYet('reader.flushSessions'),
  accountEpoch: notYet('reader.accountEpoch'),
}
