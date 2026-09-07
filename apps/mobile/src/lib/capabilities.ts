import type { UserDto } from '@textstack/shared'

/**
 * What this session is allowed to do — decided once, here, instead of in every
 * screen that happens to care.
 *
 * **The split this module exists to make.** `AuthContext` exposes exactly one
 * predicate, `isAuthenticated: user !== null` (`src/context/AuthContext.tsx`),
 * and roughly seventy call sites read it. A guest session flips all seventy at
 * once, which sounds catastrophic and mostly is not — because those sites do
 * not all ask the same question:
 *
 * - **Session predicates (~16 sites, the majority).** "Do I have a token, so
 *   can I call `/me/*`?" A guest is a real `User` row on the server with real
 *   tokens; its progress, highlights, bookmarks and vocabulary all sync exactly
 *   like an account's. `useReadingSession`, `useReaderHighlights`,
 *   `useReaderBookmarks`, `useReaderVocabMap`, `useQuickStats`, the library tab
 *   — all of these are ALREADY CORRECT for a guest and are deliberately not
 *   migrated to this module, now or later. Touching them would break syncing
 *   for the exact users we are trying to serve.
 * - **Account predicates (~8 sites).** "Is there a durable, recoverable account
 *   behind this session?" Only these get capabilities.
 *
 * A capability is therefore "may this session do X", and for most of them the
 * answer happens to be `isAccount`. Not all: `canUpload` is a session predicate
 * (below), which is why the flags are named after the *action* and not after the
 * kind of viewer — the day one moves across the line, only its own line changes.
 *
 * **Why named capabilities and not a bare `isGuest` flag.** A flag forces every
 * screen to re-derive `isAuthenticated && !user?.isGuest` inline, and the
 * re-derivation is where it goes wrong. Live example: on `app/(tabs)/profile.tsx`
 * the pencil icon is hidden behind `!isGuest`, but the `TouchableOpacity` that
 * wraps it still calls `startEdit` on tap, and `pickAvatar` has no guard at all
 * — so a guest can silently `PUT /me/profile` on a throwaway row. The policy was
 * written twice in one screen and only one copy was right. Here it is written
 * once, with its reason, and can be unit-tested.
 *
 * Pure by construction: no React, no import from `src/context/*`. Mobile's
 * `vitest.config.ts` only collects `src/lib/**`, so this is also the only shape
 * of the rule that can have tests at all.
 */
export interface Capabilities {
  // ---- Facts about the session ------------------------------------------

  /**
   * There are tokens and a server-side `User` row. **True for a guest** — this
   * is the single most misunderstood fact in this design. A guest is not a
   * logged-out visitor; it is an account without an identity, and every `/me/*`
   * write works for it.
   */
  hasSession: boolean
  /** Session exists and is the anonymous kind (`user.isGuest` from the server). */
  isGuest: boolean
  /** Session exists and is a durable, recoverable account. `hasSession && !isGuest`. */
  isAccount: boolean

  // ---- Policy -----------------------------------------------------------

  /**
   * Upload a book of one's own.
   *
   * **A session predicate, not an account predicate** — and the only capability
   * on this side of the line. It was `isAccount` until 2026-09-06, on the
   * argument that a guest who uploads their only book and then loses the device
   * has lost the book. True, and beside the point: the product's thesis is
   * *user books first, catalogue second*, and a policy that answers "bring the
   * book you actually want to finish" with a sign-in wall contradicts it. The
   * thesis wins. Recorded as a reversal in
   * `docs/01-architecture/adr/ADR-014-guest-sessions.md` §3.
   *
   * Nothing on the server changed, because nothing had to. A guest resolves to
   * the `Guest` entitlement tier — one book, 50 MB (`Entitlements:Tiers:Guest`,
   * `backend/src/Api/appsettings.json`) — so the allowance being spent here is
   * one the tier already grants, metered by the same code that meters everyone
   * else's. The upload was never refused; it was hidden.
   *
   * `hasSession`, not `true`, because `POST /me/books/upload` needs a bearer
   * token and mobile mints a guest from exactly one trigger — opening a book
   * (`ReaderSessionGate`). An install that has only ever browsed the catalog has
   * no session and no row to hang a file on, so for it this is still false and
   * the affordance still asks for an account. See "Open" in the ADR.
   *
   * Contrast `canUseAi`, which stays `isAccount` and is a cost decision the
   * server enforces itself.
   */
  canUpload: boolean
  /**
   * Use the LLM features — librarian, tutor, "Ask this book".
   *
   * These call paid inference, and every rate-limit bucket that fronts them
   * partitions on IP only (`ServiceCollectionExtensions.RateLimiting.cs`:
   * `librarian`, `tutor`, `rag.ask`, `studybuddy` all key on
   * `RemoteIpAddress`). A guest hole here is therefore throttled by IP and by
   * nothing else, and guest sessions are free and unlimited to mint.
   *
   * Deliberately NOT covered by this flag: **translation and dictionary**.
   * `POST /translate` and `GET /dictionary/{lang}/{word}` are anonymous
   * endpoints today and must stay available to guests — the core reading loop
   * (tap a word, understand it, keep reading) depends on them, and that loop is
   * the product. Gating them would gate reading itself.
   */
  canUseAi: boolean
  /**
   * Edit the display name or avatar.
   *
   * A guest's email is generated (`guest-<hex>@guest.local`, `AuthService.cs`)
   * and its visible identity comes from `packages/shared/src/anon/`. Naming a
   * row that exists only until the device is wiped is a setting with no
   * consequence — and today the edit path silently reaches `PUT /me/profile`
   * anyway, which is worse than refusing.
   */
  canEditIdentity: boolean
  /** Delete the account. Nothing to delete when there is no account. */
  canDeleteAccount: boolean
  /**
   * Read the same library on a second device.
   *
   * The honest, one-line reason a guest should ever sign up — and the only
   * capability here whose purpose is to be *shown* to a guest rather than
   * hidden from one.
   */
  canSyncAcrossDevices: boolean
  /**
   * Sign out without a confirmation step.
   *
   * False for a guest: the SecureStore tokens are the ONLY handle on that
   * account. The server row survives — `GuestCleanupWorker` never prunes a
   * guest holding vocabulary, highlights, bookmarks or progress — but with the
   * tokens gone it is unreachable forever, by anyone, including us. So for a
   * guest, "Sign Out" is a delete with a friendly label and needs a destructive
   * confirm.
   *
   * True with no session at all: vacuous, there is nothing to lose.
   */
  canSignOutSilently: boolean
}

/**
 * Map the one thing the app knows about the viewer — the user row, or `null`
 * before sign-in — onto the capability set above.
 *
 * Total and pure: same input, same answer, no clock, no storage, no network.
 */
export function capabilitiesFor(user: UserDto | null): Capabilities {
  const hasSession = user !== null
  const isGuest = hasSession && user.isGuest
  const isAccount = hasSession && !isGuest

  return {
    hasSession,
    isGuest,
    isAccount,
    // The one capability a guest shares with an account. `hasSession` because
    // the upload needs a token, not because it needs an identity.
    canUpload: hasSession,
    canUseAi: isAccount,
    canEditIdentity: isAccount,
    canDeleteAccount: isAccount,
    canSyncAcrossDevices: isAccount,
    // Note the asymmetry: `!isGuest`, not `isAccount`. Signed out is already
    // signed out; only a guest has something irrecoverable to lose.
    canSignOutSilently: !isGuest,
  }
}
