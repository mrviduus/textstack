/**
 * The session's write side: one serial queue, one monotonic epoch, and the one
 * guarded write that needed both.
 *
 * Lifted out of `AuthContext` for the same reason `createSingleFlight` was —
 * `src/lib/**` is the only mobile layer Vitest collects (`vitest.config.ts`),
 * and the concurrency here is exactly the part that had no coverage while the
 * pure decisions around it had plenty.
 *
 * **What the queue is for.** `signInWithTokens` writes three SecureStore keys
 * with an `await` between each. Without serialisation a guest mint resolving
 * mid-login lands *between* two of them and leaves a guest access token paired
 * with an account refresh token — a mixture nothing checks for, which surfaces
 * a launch later as a 401 loop. The epoch alone cannot fix that: it tells a
 * block it lost, but only after the block has already written key one of three.
 * Running each block exclusively is what makes "abort all three writes"
 * actually mean all three.
 *
 * **What the epoch is for.** It is bumped SYNCHRONOUSLY, before any `await`, by
 * every operation that replaces the session — sign-in, sign-out, terminal auth
 * failure. Work that started earlier captures it and refuses to write if it has
 * moved.
 */

/** The three keys the session lives in. */
export const ACCESS_TOKEN_KEY = 'access_token'
export const REFRESH_TOKEN_KEY = 'refresh_token'
export const USER_KEY = 'user'

/** The SecureStore surface these helpers need. Narrow on purpose: injectable. */
export interface SessionStore {
  getItemAsync(key: string): Promise<string | null>
  setItemAsync(key: string, value: string): Promise<void>
  deleteItemAsync(key: string): Promise<void>
}

export interface WriteQueue {
  /** Current session generation. Read it before your first `await`. */
  readonly epoch: number
  /**
   * Start a new generation. Call synchronously, at the top of any operation
   * that replaces the session, BEFORE anything can yield.
   */
  bumpEpoch(): void
  /**
   * Run `fn` with nothing else from this queue running. Resolves/rejects with
   * `fn`'s own outcome.
   */
  run<T>(fn: () => Promise<T>): Promise<T>
}

export function createWriteQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve()
  let epoch = 0

  return {
    get epoch() {
      return epoch
    },
    bumpEpoch() {
      epoch += 1
    },
    run<T>(fn: () => Promise<T>): Promise<T> {
      // `.then(fn, fn)` so a rejected predecessor cannot wedge the queue: the
      // next block runs either way. The tail is then swallowed separately so a
      // rejection that the caller handles does not also surface as an
      // unhandled rejection on the queue's own chain.
      const next = tail.then(fn as () => Promise<T>, fn as () => Promise<T>)
      tail = next.then(
        () => {},
        () => {},
      )
      return next
    },
  }
}

/**
 * Why a queued profile write was thrown away, or that it landed.
 *
 * Two distinct discard reasons because they are two distinct races and a
 * reader of a log line deserves to know which one happened.
 */
export type UserWriteResult = 'written' | 'discarded:epoch-moved' | 'discarded:session-gone'

/**
 * Persist the cached `user` row — but never resurrect a session that ended.
 *
 * **The bug this closes.** `updateUser` was the one queued writer that did not
 * consult the epoch. The once-per-session profile refetch passes its `cancelled`
 * check, `signOut()` bumps the epoch and enqueues its three deletes, and
 * `updateUser` enqueues *after* and rewrites the `user` key. The result is a
 * `user` with no tokens, which `decideMint` reads as `session-exists` forever:
 * `ensureSession` never mints again and every request 401-loops until the app
 * is reinstalled. `NativeLanguageContext.setNativeLanguage` reaches this same
 * path (`updateProfile` → `updateUser`), so it is reachable from ordinary use,
 * not just from a race a test has to construct.
 *
 * **Two guards, because the epoch alone is not enough.** The epoch catches the
 * caller whose data predates the session change. It does NOT catch the ordering
 * the bug report actually describes: if `signOut()` bumps *before* `updateUser`
 * is called, `updateUser` captures the already-bumped epoch, compares equal,
 * and still writes after the deletes. That window is real — the profile effect
 * spends a network round-trip inside `getProfile()` and its `cancelled` flag is
 * only set on a React commit, which lags `signOut()`. So the second guard is
 * the invariant itself: **never write `user` when there is no access token**.
 * That is precisely the corrupt state ("user present, tokens gone") and it is
 * cheap to check from inside the exclusive block, where nothing else can be
 * mid-write.
 *
 * A store read that *throws* is not treated as "no session" — an unreadable
 * keychain must not silently drop legitimate profile updates. In that case the
 * epoch check stands alone, which is where we were before.
 */
export async function writeUserIfCurrent(args: {
  queue: WriteQueue
  store: SessionStore
  /** Already serialised — the caller owns the DTO shape. */
  json: string
  /** Called inside the exclusive block, only if the write landed. */
  onApplied: () => void
}): Promise<UserWriteResult> {
  const { queue, store, json, onApplied } = args
  // Captured before `run` enqueues, and with no `await` above it: this is the
  // whole point of the epoch contract.
  const epochAtStart = queue.epoch
  return queue.run(async (): Promise<UserWriteResult> => {
    if (queue.epoch !== epochAtStart) return 'discarded:epoch-moved'
    let hasToken = true
    try {
      hasToken = (await store.getItemAsync(ACCESS_TOKEN_KEY)) !== null
    } catch {
      // Unreadable, not absent. Fall back to the epoch check alone.
      hasToken = true
    }
    if (!hasToken) return 'discarded:session-gone'
    await store.setItemAsync(USER_KEY, json)
    onApplied()
    return 'written'
  })
}
