/**
 * The platform seam (ADR-035): the only code that knows if the app runs on the web or in the Android shell.
 * Screens and hooks use `platform` and never ask which platform it is.
 *
 * The build picks the implementation: `VITE_TARGET=web` (the default) uses `web.ts`, `VITE_TARGET=android`
 * uses `android.ts`. `vite.config.ts` resolves `@platform-target` to one of the two files, so the other file
 * is not in the bundle.
 *
 * The reader route's members are in `reader.ts`, a second module: only the reader's lazy chunk loads them.
 */
import type { highlightCoverUrl, highlightsApi } from '@textstack/shared'
import type * as auth from '../api/auth'
import type * as userBooks from '../api/userBooks'
import type { MergeMap } from '../lib/mergeMap'
import type * as vocabulary from '../api/vocabulary'

/**
 * An implementation also sets up the shared API client (`initApi`) on load. The rest of the app
 * imports `api/client.ts`, which imports this file, so the client is set up before first use.
 *
 * An implementation imports app modules, and some of them import this file back. So never read
 * `platform` at module load outside this folder: read it inside a function.
 */
export interface Platform {
  /** How calls to the API identify the reader. Web: the session cookie. Android: a bearer token. */
  transport: {
    /** What a direct `fetch` to the API adds to its `RequestInit`. Synchronous: a write in `pagehide` uses it. */
    fetchInit(): { credentials?: RequestCredentials; headers?: Record<string, string> }
  }
  /**
   * The account calls: sign-in, sign-out, the guest session, the profile. Web: `api/auth.ts`, the session cookie.
   * Android: the same routes in bearer mode, the tokens in secure storage. The signatures are the ones in `api/auth.ts`.
   */
  account: Pick<typeof auth,
    | 'getCurrentUser' | 'refreshToken' | 'loginWithEmail' | 'registerWithEmail' | 'loginWithGoogle' | 'logout'
    | 'createGuestSession' | 'forgotPassword' | 'resetPassword' | 'updateProfile' | 'uploadAvatar' | 'deleteAvatar'
    | 'deleteAccount' | 'approveDevice' | 'denyDevice'>
  /** What the account's data does as the session changes (`AuthContext` tells it). */
  session: {
    /** A user is set (a sign-in, a restored session, a new guest). Web: starts the server probe. */
    userSet(): void
    /** The start-up session check ended, with or without a user. */
    settled(): void
    /** The account changed (sign-out, another account): drop the previous account's data in memory. */
    accountChanged(): void
    /** After a sign-in: re-key the local stores by the merge map, then send what was made without a session. */
    signedIn(merge: MergeMap | undefined): Promise<void>
    /** A real (not guest) session was restored at start: send what was made without a session. */
    restored(): Promise<void>
  }
  /**
   * True on the website: it shows its own parts, the cookie banner, the banner for the Android app and the
   * footer's links to the Play store. False in the Android app. The footer itself stays: it has the legal
   * and account links. The analytics script in `index.html` is not covered: the shell build drops it (#1643).
   */
  siteChrome: boolean
  /**
   * True in the Android app: it opens on the library (no landing page), has no site footer and always shows
   * the tab bar. False on the website, where a phone-width screen gets the same layout from CSS alone.
   */
  appShell: boolean
  /**
   * The `src` for an image the API serves to its owner (a book's cover). Web: the URL itself, the cookie goes
   * with it. Android: an `<img>` sends no bearer, so the image is fetched with it and the answer is a blob: URL
   * (undefined when the fetch fails). Runs in render: never throws; the same URL gives the same answer.
   */
  imageSrc(url: string): string | Promise<string | undefined>
  /** Google sign-in. Web: Google Identity Services. Android: the native account chooser. */
  google: {
    /** Sets up the sign-in once. `onIdToken` gets the Google id token of each sign-in. False: not offered. */
    init(onIdToken: (idToken: string) => void): Promise<boolean>
    /** Draws the Google button into `el`. */
    renderButton(el: HTMLElement): void
    /** After sign-out: the next sign-in does not pick the account by itself. */
    signOut(): void
  }
  /**
   * The reader's books: the library, the book page, upload, finish and delete. Web: the server
   * (`api/userBooks.ts`). Android: the library on the device. The signatures are the ones in `api/userBooks.ts`.
   */
  library: Pick<typeof userBooks,
    | 'getUserBooks' | 'getUserBook' | 'getUserBookProgress' | 'getUserTags'
    | 'uploadUserBook' | 'deleteUserBook' | 'markUserBookComplete' | 'unmarkUserBookComplete'
    | 'bulkFinishUserBooks' | 'bulkDeleteUserBooks' | 'getUserBookCoverUrl' | 'getUserBookFileUrl'> & {
    /**
     * True on Android: the library is on the device, so the list and a book's page answer with no session
     * (the books stay readable after a sign-out). False on the web: the server needs a session.
     */
    withoutSession: boolean
  }
  /**
   * The saved words: the reader's word popup, the vocabulary page and the review. Web: the server
   * (`api/vocabulary.ts`). Android: the store on the device. The signatures are the ones in `api/vocabulary.ts`.
   */
  vocabulary: Pick<typeof vocabulary,
    | 'saveWord' | 'getWords' | 'deleteWord' | 'deleteAllWords' | 'updateWord' | 'restoreWord'
    | 'getReaderVocab' | 'getReviewQueue' | 'submitReview'>
  /** The highlights page: every highlight of every book. Web: the server. Android: the store on the device. */
  highlights: Pick<typeof highlightsApi, 'getAllHighlights'> & {
    /** The cover of a highlight's book. */
    coverUrl: typeof highlightCoverUrl
  }
}

export { platform } from '@platform-target'
