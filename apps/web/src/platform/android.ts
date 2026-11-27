import type { Platform } from '.'

/** Every member throws until wave 5 (#1642) ports the offline library here. The stub only proves the build. */
export const notYet = (member: string) => (): never => {
  throw new Error(`platform/android: ${member} is not implemented yet (#1642)`)
}

// Wave 5 calls `initApi` here, in bearer mode, as `web.ts` does in cookie mode.

/** The Android shell (ADR-035): a local SQLite library, device files, bearer tokens. */
export const platform: Platform = {
  transport: {
    fetchInit: notYet('transport.fetchInit'),
  },
  account: {
    getCurrentUser: notYet('account.getCurrentUser'),
    refreshToken: notYet('account.refreshToken'),
    loginWithEmail: notYet('account.loginWithEmail'),
    registerWithEmail: notYet('account.registerWithEmail'),
    loginWithGoogle: notYet('account.loginWithGoogle'),
    logout: notYet('account.logout'),
    createGuestSession: notYet('account.createGuestSession'),
    forgotPassword: notYet('account.forgotPassword'),
    resetPassword: notYet('account.resetPassword'),
    updateProfile: notYet('account.updateProfile'),
    uploadAvatar: notYet('account.uploadAvatar'),
    deleteAvatar: notYet('account.deleteAvatar'),
    deleteAccount: notYet('account.deleteAccount'),
    approveDevice: notYet('account.approveDevice'),
    denyDevice: notYet('account.denyDevice'),
  },
  session: {
    userSet: notYet('session.userSet'),
    settled: notYet('session.settled'),
    accountChanged: notYet('session.accountChanged'),
    signedIn: notYet('session.signedIn'),
    restored: notYet('session.restored'),
  },
  google: {
    init: notYet('google.init'),
    renderButton: notYet('google.renderButton'),
    signOut: notYet('google.signOut'),
  },
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
