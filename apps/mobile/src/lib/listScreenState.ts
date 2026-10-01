/**
 * Which of the six things a "list of my stuff" screen can be showing.
 *
 * Vocabulary and Stats did not check at all: they fired
 * `/me/vocabulary/words` and `/me/reading/stats` on mount, took the 401, ran it
 * through `isOfflineError` (false — a 401 is a perfectly good response), and
 * landed on `failed`. The reader was told "Something went wrong on our side"
 * with a Retry button that 401s forever, when the truth was that they had no
 * account.
 *
 * So `signin` is a state, and it is the first one. It is not a kind of failure
 * and it is not reached by asking the server.
 *
 * This lives in `src/lib` on purpose: it is the only layer of these screens with
 * a test runner behind it. `apps/mobile` has no component or hook tests — the
 * vitest lane covers `src/lib/*.test.ts` and nothing else — so precedence rules
 * that stay in JSX ternaries are, in practice, unverified.
 */

/** What the screen renders. `offline` and `failed` are the two failure walls. */
export type ListScreenState =
  | 'signin'
  | 'loading'
  | 'offline'
  | 'failed'
  | 'empty'
  | 'list'

export interface ListScreenInput {
  /**
   * `useAuth().isLoading` — the SecureStore read that restores a stored session
   * is still in flight, so `isAuthenticated` is not an answer yet.
   *
   * It exists because `isAuthenticated` (`AuthContext`: `user !== null`) is
   * `false` for the whole of that window and there is nothing in a boolean that
   * can say "storage has not replied". `languageOnboarding.ts` next door hit
   * exactly this and returns `'unknown'` rather than collapsing the wait into a
   * `no`; `app/(tabs)/index.tsx` holds a blank themed view rather than redirect
   * on the guess. This machine already has a state for "I do not know yet and
   * something is in flight" — `loading` — so it does not need a seventh.
   */
  isAuthLoading: boolean
  /** From `useAuth()`. False means: do not ask the server anything. */
  isAuthenticated: boolean
  /** A first-page fetch is in flight. Pagination does not set this. */
  loading: boolean
  /** Why the last fetch did not arrive, if it did not. */
  loadError: 'offline' | 'failed' | null
  /**
   * Whether the screen has anything worth rendering. Cached or stale rows
   * count — the point is whether showing them beats showing a wall.
   */
  hasItems: boolean
}

/**
 * Precedence, in order, and each step is here because getting it wrong is a bug
 * that shipped or nearly did:
 *
 * 1. **A session we have not finished restoring outranks even "no session".**
 *    `isAuthenticated` is `false` while SecureStore is still being read, so
 *    without this a returning reader is shown the sign-in invitation for the
 *    frames it takes to answer, and then has it yanked away. Today that window
 *    is short; it becomes a guaranteed cold-start flash the moment a session is
 *    minted asynchronously. The honest render for it is the skeleton: something
 *    IS in flight, we just do not yet know for whom.
 * 2. **No session outranks everything else, including `loading`.** Both screens
 *    initialise `loading` to `true`, so ordering these the other way flashes a
 *    skeleton at a signed-out reader before settling on the invitation — a
 *    screen that pretends to be fetching something it must not fetch.
 * 3. **Loading outranks having items**, so re-searching or switching a filter
 *    shows the skeleton rather than the previous query's results.
 * 4. **Items outrank a failure.** A reader with words who went offline has a
 *    list plus a caveat, not a wall. Conflating "you have none" with "I could
 *    not ask" is the defect `vocabulary.tsx` carries a comment about.
 * 5. A failure with nothing to show becomes the wall it names.
 * 6. Otherwise: genuinely empty.
 */
export function resolveListScreenState({
  isAuthLoading,
  isAuthenticated,
  loading,
  loadError,
  hasItems,
}: ListScreenInput): ListScreenState {
  if (isAuthLoading) return 'loading'
  if (!isAuthenticated) return 'signin'
  if (loading) return 'loading'
  if (hasItems) return 'list'
  if (loadError) return loadError
  return 'empty'
}
