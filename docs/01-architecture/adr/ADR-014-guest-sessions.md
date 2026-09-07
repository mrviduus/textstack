# ADR-014 — Anonymous guest sessions

**Status:** Accepted · **Date:** 2026-09-06 · **Shipped** on web from PR #453 (reader, upload,
pending-vocabulary triggers), on mobile in the guest-session PR that this record accompanies.

> **Amended 2026-09-06 — §3, upload, reversed. See [§3a](#3a-amendment-2026-09-06--upload-is-open-to-a-guest).**
> The original row and its reason are left exactly as written below; the amendment sits under them
> and says what replaced them and why. An ADR that quietly grows the answer it should have given is
> not a record of anything.

Related: [ADR-002](002-google-auth-only.md) is **stale** — it records Google-only auth, and
email/password and Apple sign-in both shipped afterwards. It is left as written; this ADR does not
supersede it, it only records the tier *below* it.

This documents a posture the code already enforces in three places (the server's entitlement tiers,
the mobile capability module, the endpoint filter) and which had never been written down anywhere a
reviewer would find it. The consequence of that was a client-side gate believed to be a boundary —
see "AI is a cost decision" below.

## Context

TextStack's thesis is that fluency comes from long-form reading, and the loop that delivers it is
*read → tap a word → save it → review it*. Every step past the first writes to `/me/*`. So a person
who has not signed up can read, and nothing they do while reading survives — the product's core loop
is gated behind an account they have no reason to want yet.

Two facts shape the answer.

**The reader is not a logged-out visitor; it is an account nobody has claimed.** Progress,
highlights, bookmarks and vocabulary are all user-keyed rows. Anything that keeps them has to key
them to *something*, and the only durable something is a `User` row.

**Mobile's session predicate is a single boolean.** `AuthContext` exposes `isAuthenticated`, defined
as `user !== null`, and roughly seventy call sites read it. Whatever an anonymous session is, it
flips all seventy at once.

## Decision

### 1. An anonymous reader is a real `User` row, minted on demand

`POST /auth/guest` creates a `User` with `IsGuest = true`, a synthesized
`guest-<hex>@guest.local` email, no password, and a normal access/refresh pair — a 60-minute access
token and a refresh token on the shorter guest TTL (`Jwt:GuestRefreshTokenExpiryDays`, 30 days;
accounts get `RefreshTokenExpiryDays`). Everything downstream of it — `/me/progress`,
`/me/highlights`, `/me/vocabulary/*` — works unchanged, because from the API's point of view nothing
about the request is unusual.

**On demand, never at launch.** Web mints from three triggers (reader mount, upload, the third
pending vocabulary word). Mobile mints from exactly one: opening a book, through
`ReaderSessionGate`. Minting at launch would create a row for every install that browses the catalog
and leaves.

### 2. Registration promotes that row in place; sign-in merges it

`AuthService.RegisterWithEmailAsync` takes the guest id and rewrites the *same* row — email, name,
password hash, `IsGuest = false`. No rows move, so nothing can be lost in the moving.

Signing in to an **existing** account is the harder case and goes through `MergeGuestAsync`, which
re-parents every user-keyed entity from the guest to the account in one transaction. Conflict rule:
the account's row wins on every unique-keyed table except `ReadingProgress`, where the newer of the
two wins (last-write-wins on `UpdatedAt`).

### 3. What a guest may not do, and why each one

The policy lives in config (`Entitlements:Tiers:Guest`) and is mirrored — not re-decided — by the
client in `apps/mobile/src/lib/capabilities.ts`.

| Capability | Guest | Reason |
|---|---|---|
| Read, translate, look a word up | **yes** | `POST /translate` and `GET /dictionary/{lang}/{word}` are anonymous endpoints. Gating them gates reading itself. |
| Save vocabulary, highlight, bookmark, keep progress | **yes** | This is the loop. It is the whole point of the row existing. |
| Upload a book | ~~no~~ **yes**, see [§3a](#3a-amendment-2026-09-06--upload-is-open-to-a-guest) | ~~**A product choice, not a server constraint.** `Entitlements:Tiers:Guest` allows one book at 50 MB, and the server would accept it. A guest who uploads their only book and then loses the phone has lost the book, and we took the storage to arrange that. Upload is the moment to ask for an account.~~ |
| Librarian, tutor, "Ask this book", book chat, RAG indexing | no | **A cost decision.** These spend paid inference. Guest sessions are free and unlimited to mint, and every limiter fronting those routes partitions on IP alone. |
| Edit name or avatar | no | The identity is generated and visible to nobody. A setting with no consequence. |
| Delete the account | no | Nothing to delete that signing out has not already put out of reach. |
| Sign out without confirmation | no | See §5. |

Vocabulary saving is allowed but **metered**: `Entitlements:Tiers:Guest:DailyEnrichmentCap` (50/day)
clamps the user's own daily cap, because each new word queues LLM enrichment (distractors, hint,
explanation). The cap and the on/off switch are separate knobs on purpose — the cap meters a feature
the tier *has*, `AiEnabled` decides whether it has it.

Both default permissively when unset: an absent or `<= 0` value means *unlimited* / *allowed*. The
failure mode of a config typo is then a bill, not a silent outage for paying users.

### 3a. Amendment (2026-09-06) — upload is open to a guest

**Reversed the same day this record was written** — the code it describes landed on `main` one day
earlier (#554). The reason given above is not wrong on its facts, and is left standing; it is
outranked.

**Why it was reversed.** The product's thesis is *user books first, catalogue second* — the reader
this app is for arrives with a book they already intend to finish, and the catalogue of classics is
the fallback, not the offer. §3 answered that reader's first action with a sign-in wall. The two
cannot both be true, and the thesis is the one everything else is built on, so the gate goes. The
loss the original reason names — a guest who uploads their only book and then loses the device
loses the book — is real, and is the same loss §5 already accepts for their vocabulary, highlights
and progress. We do not gate those; gating this one was inconsistent as well as off-thesis.

**Nothing on the server changed, because nothing had to.** `Entitlements:Tiers:Guest` already grants
`MaxBooks: 1` at `StorageLimitBytes: 52428800`, and `POST /me/books/upload` already accepted a guest
token. This was a client affordance, never a boundary — the same shape of mistake §4 describes for
AI, caught before it could be described as security.

**The predicate: `hasSession`, not `true`.** `canUpload` moves from the account side of §6 to the
session side, and is now the only capability there. Not unconditional, because the upload needs a
bearer token and mobile mints a guest from **one** trigger — opening a book (`ReaderSessionGate`,
§1). An install that has only browsed the catalogue has no row to attach a file to, so for it the
answer is still no and the affordance still asks for an account.

**What moved with it** (`apps/mobile`): the `+` tab (`app/(tabs)/_layout.tsx`), its button
(`src/components/UploadTabButton.tsx`), the screen's own guard and its quota fetch
(`app/my-books/upload.tsx`), the Profile *Upload space* row (`app/(tabs)/profile.tsx`), and the
empty-library primary CTA (`src/components/library/FirstBookState.tsx`), which now offers a guest
*Upload a book* rather than demoting it to a sign-in link.

**One defect the reversal exposed.** `MaxBooks` is `null` on every non-guest tier, so
`UserBookService`'s tier refusals had never been reachable, and the upload screen mapped their
`400 { error }` to "This file looks invalid. Try another one." A guest's *second* upload is refused
with `"Guest accounts can upload 1 book. Sign up for more."` — the correct copy and the conversion
prompt in one sentence — which that mapping would have discarded. `app/my-books/upload.tsx` now
prefers the server's message on a 400. Worth noting that the string was written for a guest long
before the client allowed one: the server has expected this upload all along.

**What deliberately did NOT move.** `canUseAi` stays `isAccount`. §4 is a cost decision about paid
inference, enforced server-side by `RequireAiAccount()` with a 403; this amendment is about an
allowance the guest tier already holds. The two arguments have nothing in common, and moving both
because they sat in the same table would be the failure this document exists to prevent.

**The bill this leaves.** See "Consequences" — a guest may now hold 50 MB of storage on a row nobody
will ever claim, and `GuestCleanupWorker` preserves a guest holding uploads indefinitely. That is
recorded, not solved.

### 4. The client flag is an affordance; the server is the boundary

`capabilitiesFor(user).canUseAi` decides what the app *shows*. It decides nothing about what the API
*accepts* — a guest token is a valid bearer token, and before this every paid-inference route
answered a guest with a real model call. `RequireAiAccount()` (`Api/Extensions/AiAccountPolicy.cs`)
is an endpoint filter that resolves the caller's tier and refuses before the handler runs.

It returns **403** with `error: "account_required"`, deliberately distinct from 401. The two mean
different things to a client and produce different copy: 401 is *sign in*, 403 here is *sign **up***.

### 5. Sign-out is a different operation for a guest

For an account, sign-out clears three SecureStore keys and an email and password get all of it back
on any device. For a guest those three keys are the **only** handle that exists: there is no email to
sign in with and no password. The row itself survives — `GuestCleanupWorker` refuses to prune a guest
holding vocabulary, highlights, bookmarks, library rows, uploads, notes or progress — so the books
stay on the server forever and nothing can ever reach them again, including us.

That is a delete. It gets a destructive confirm that names what disappears.

### 6. `isAuthenticated` stays the session predicate; a capability set owns account policy

The seventy call sites do not all ask the same question.

- **~16 mean "do I have a token, so can I call `/me/*`?"** — `useReadingSession`,
  `useReaderHighlights`, `useReaderBookmarks`, `useReaderVocabMap`, `useQuickStats`, the library
  tab. All of these are *already correct* for a guest and are deliberately not migrated. Changing
  them would break syncing for exactly the readers this work exists to serve.
- **~8 mean "is there a durable, recoverable account behind this?"** — only these consult
  `capabilitiesFor(user)`.

So `isAuthenticated` keeps its meaning, and a pure total function
(`apps/mobile/src/lib/capabilities.ts`) answers the second question by name.

The one place where the obvious migration is wrong is the root redirect: `/` keys on `isAccount`, not
`hasSession`, so a guest still lands on Discover rather than an empty Library.

## Alternatives rejected

**A bare `isGuest` boolean on the auth context.** It forces every screen to re-derive
`isAuthenticated && !user?.isGuest` inline, and the re-derivation is where it goes wrong. Live
example, on one screen: `profile.tsx` hid the edit pencil behind `!isGuest` while the
`TouchableOpacity` wrapping it still called `startEdit`, and `pickAvatar` beside it had no guard at
all — so a guest could `PUT /me/profile` on a throwaway row. The policy was written twice in one file
and only one copy was right. A capability name (`canEditIdentity`) says what the caller may *do*, so
a reviewer can see it is on the wrong control; `!isGuest` says only what the viewer *is* and reads
plausible next to anything. `capabilityLiterals.test.ts` fails the build on the re-derivation, with a
short allow-list where each entry carries its reason.

**A client-only gate.** What we had. A guest token is a valid bearer token, so it was never a
boundary — the whole paid-inference surface was account-only in the UI and open on the wire.

**Device-local state with no server row.** Keeping a guest's words in AsyncStorage/IndexedDB avoids
the row, and then every one of them has to be replayed at sign-up through a queue that has its own
failure modes, its own conflict rules and no server-side test. It also cannot sync, cannot survive a
reinstall, and produces a second, divergent implementation of every write path. The row is cheaper
and it is the same code.

**Minting at app launch.** Rejected on cost (§1) and because it makes the first launch of a browsing
visitor indistinguishable from a reader's.

## Consequences

- **One `User` row per install that opens a book.** Pruned only when it holds nothing durable:
  `GuestCleanupWorker` runs every 2h and deletes guests inactive 30 days, excluding any that hold
  vocabulary, highlights, bookmarks, library rows, uploads, notes or progress. An engaged guest lives
  indefinitely, which is intended and is what makes §5 true.
- **`ReadingSessions` are excluded from that preservation filter by design**, and reading alone does
  not refresh `LastActiveAt` (see Open). So a guest who reads daily and saves nothing is still
  reaped at 30 days.
- **A guest can now hold 50 MB of unreachable disk, forever** (§3a). `GuestCleanupWorker` prunes a
  guest only when it holds nothing durable, and an upload is durable — so a guest who uploads one
  book, signs out (§5: their tokens are the only handle) or simply reinstalls, leaves a file on the
  server that nothing can reach and nothing will collect. Bounded per row at one book / 50 MB, and
  unbounded in the number of rows, because guest sessions are free to mint. Nothing is built for
  this yet, on purpose: the cheap answer is a shorter retention for guests holding *only* an upload
  and no reading activity, and picking that number needs a real occupancy figure rather than a
  guess. Measure `sum(bytes)` over guests with an upload and no session in 30 days before choosing.
- **The merge is a growing surface.** Every new user-keyed table must be added to `MergeGuestAsync`,
  and getting it wrong is not a compile error. `UserChapterChunk` is the cautionary case: its
  `UserId` is denormalized off `UserBook` with no FK, so missing it leaves rows that outlive the
  guest and a silently dead "Ask this book" on a visible library book.
- **The merge never throws on a constraint violation.** It catches SQLSTATE class 23 only, logs at
  Error, and returns `false`; everything else (timeouts, cancellation) still propagates, because
  those are the cases where retrying works. The trade is explicit: a swallowed conflict orphans the
  guest's data, but letting it escape turns one bad row into a permanent sign-in outage — the client
  re-presents the same guest token on every attempt, and the only mobile "fix" is wiping app data,
  which destroys the guest session too.
- **Sign-in can now report a partial outcome.** `guestMergeSkipped` (`invalid_token` |
  `merge_conflict`) is additive and optional on both auth responses. No client reads it yet; the
  server-side Warning per occurrence is what makes the rate countable.
- **A guest's `NativeLanguage` is carried across on merge**, and never clobbers an account's own.

## Open

- **`GuestActivityMiddleware` is dead code.** It reads `context.User.FindFirst("is_guest")`, but the
  API registers no ASP.NET authentication middleware at all — auth is manual per endpoint via
  `GetUserId`. `context.User` never carries the claim, so `LastActiveAt` is only ever written at
  guest creation. This was harmless while mobile minted no guests. It no longer is.
- **The first-run reader still cannot upload** (§3a). `canUpload` is `hasSession`, and mobile mints a
  session only when a book is opened — so a fresh install that goes straight to Library sees the
  sessionless CTA, which is a sign-in link. Web already mints on upload as one of its three
  triggers; mobile has one. Adding upload as a second mint trigger is the obvious completion of this
  amendment and is deliberately not bundled into it.
- **No client surfaces `guestMergeSkipped`.** The server stopped being silent; the app has not yet
  started speaking.
- **The account-required 403 has no dedicated client copy on every surface.** The affordances are
  hidden, so it is reachable mainly by a stale client or a direct call.

## Enforced by

- `backend/src/Api/Extensions/AiAccountPolicy.cs` — the 403, and `GuestAiAccessTests`
- `backend/src/Application/Entitlements/EntitlementOptions.cs` — `AiEnabledFor`,
  `DailyEnrichmentCapFor`, and their permissive defaults
- `backend/src/Application/Auth/AuthService.cs` — in-place promotion and `MergeGuestAsync`
- `apps/mobile/src/lib/capabilities.ts` + `capabilities.test.ts` — the policy, once, including
  §3a's `canUpload: hasSession` asserted on all three rows (no session / guest / account)
- `apps/mobile/src/lib/capabilityLiterals.test.ts` — the ban on re-deriving it
- `apps/mobile/src/lib/profileActions.ts` — the sign-out branch
- `tests/TextStack.IntegrationTests/GuestSessionEndpointTests.cs`, `GuestMergeDurabilityTests.cs`,
  `GuestMergeConflictTests.cs`, `GuestMergeSkipReportingTests.cs`,
  `GuestEnrichmentCapEnforcementTests.cs`
- `docs/qa/scenarios/QA-005-guest-loop.md` — the wiring no runner reaches
