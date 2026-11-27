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
import type * as userBooks from '../api/userBooks'

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
   * The reader's books: the library, the book page, upload, finish and delete. Web: the server
   * (`api/userBooks.ts`). Android: the library on the device. The signatures are the ones in `api/userBooks.ts`.
   */
  library: Pick<typeof userBooks,
    | 'getUserBooks' | 'getUserBook' | 'getUserBookProgress' | 'getUserTags'
    | 'uploadUserBook' | 'deleteUserBook' | 'markUserBookComplete' | 'unmarkUserBookComplete'
    | 'bulkFinishUserBooks' | 'bulkDeleteUserBooks' | 'getUserBookCoverUrl' | 'getUserBookFileUrl'>
}

export { platform } from '@platform-target'
