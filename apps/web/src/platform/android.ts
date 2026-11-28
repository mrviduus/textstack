import type { Platform } from '.'
import { account } from './android/account'
import { APP_HEADERS, cachedAccessToken, setupApi } from './android/api'
import { google } from './android/google'
import { startSyncProbe } from './android/syncClient'

/** A member still to come in wave 5 (#1642): it throws. */
export const notYet = (member: string) => (): never => {
  throw new Error(`platform/android: ${member} is not implemented yet (#1642)`)
}

// The shared API client in bearer mode, on load (`web.ts` sets cookie mode the same way).
setupApi()

/** Bumped when the session's account changes: the reader drops what an earlier account's session started. */
let accountEpoch = 0
export const currentAccountEpoch = () => accountEpoch

/** The Android shell (ADR-035): a local SQLite library, device files, bearer tokens. */
export const platform: Platform = {
  transport: {
    // Synchronous (a `pagehide` write uses it), so the token is the cached copy; never throws.
    fetchInit: () => {
      const token = cachedAccessToken()
      return { headers: { ...APP_HEADERS, ...(token ? { Authorization: `Bearer ${token}` } : {}) } }
    },
  },
  account,
  session: {
    // The V2 probe once a user is set (the Expo AuthContext's userId effect).
    userSet: () => void startSyncProbe(),
    settled: () => {},
    accountChanged: () => { accountEpoch++ },
    // account.ts already claimed the device library and adopted a guest's, before the UI set the user.
    signedIn: async () => {},
    restored: async () => {},
  },
  siteChrome: false,
  google,
  library: {
    getUserBooks: notYet('library.getUserBooks'),
    getUserBook: notYet('library.getUserBook'),
    getUserBookProgress: notYet('library.getUserBookProgress'),
    getUserTags: notYet('library.getUserTags'),
    uploadUserBook: notYet('library.uploadUserBook'),
    deleteUserBook: notYet('library.deleteUserBook'),
    markUserBookComplete: notYet('library.markUserBookComplete'),
    unmarkUserBookComplete: notYet('library.unmarkUserBookComplete'),
    bulkFinishUserBooks: notYet('library.bulkFinishUserBooks'),
    bulkDeleteUserBooks: notYet('library.bulkDeleteUserBooks'),
    getUserBookCoverUrl: notYet('library.getUserBookCoverUrl'),
    getUserBookFileUrl: notYet('library.getUserBookFileUrl'),
  },
  vocabulary: {
    saveWord: notYet('vocabulary.saveWord'),
    getWords: notYet('vocabulary.getWords'),
    deleteWord: notYet('vocabulary.deleteWord'),
    deleteAllWords: notYet('vocabulary.deleteAllWords'),
    updateWord: notYet('vocabulary.updateWord'),
    restoreWord: notYet('vocabulary.restoreWord'),
    getReaderVocab: notYet('vocabulary.getReaderVocab'),
    getReviewQueue: notYet('vocabulary.getReviewQueue'),
    submitReview: notYet('vocabulary.submitReview'),
  },
  highlights: {
    getAllHighlights: notYet('highlights.getAllHighlights'),
    coverUrl: notYet('highlights.coverUrl'),
  },
}
