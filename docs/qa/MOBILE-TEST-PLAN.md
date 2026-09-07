# Mobile automated testing — task brief

**For:** whoever picks up mobile test automation (works standalone, in parallel with feature work).
**Status:** not started. This brief is the spec, not a report.

---

## Why now

Three regressions reached the owner's device this week — dead routes on every catalog
shelf item, a Library screen carrying 13 blocks of chrome before the first book, and a
sign-in that landed on Profile. None was caught by a test. The suite that should have
caught them exists and is both **too loose to fail** and **not run by CI**.

Measured on `apps/mobile/e2e/tests/` as it stands:

| | |
|---|---|
| `test(...)` blocks | 22 |
| assertions that can actually fail | **5** |
| `expect(await …isVisible().catch(() => false)).toBeTruthy()` | **17** |

That last shape cannot fail usefully: the `catch` swallows the timeout, and the matcher
then asserts a boolean the test itself produced. `navigation.spec.ts` checks that a
Library screen contains any of `Saved|My Library|Sign In` — it would pass on a blank
page with a sign-in button, and it passed throughout the week the screen was unusable.

And `.github/workflows/ci.yml:112` deliberately excludes the suite:

> *"apps/mobile/e2e is Playwright driving the Expo web build in a Pixel-sized viewport —
> it exercises no native code path, so running it in CI would buy confidence it cannot
> actually provide."*

Half right. It cannot test native code — but nothing that broke this week was native.
Navigation, list composition, redirects and empty states are exactly what it *can* test,
and exactly what failed.

---

## Two lanes, and the boundary between them

**Playwright cannot drive a native app on an emulator.** It drives browsers. Expo's web
build is a browser target, so Playwright tests the JS/IA layer; anything touching a
native module needs a native runner.

`maestro` is already installed on the Mac (`/opt/homebrew/bin/maestro`). No Detox, no
Maestro flows in the repo yet.

| | **Lane A — Playwright** | **Lane B — Maestro** |
|---|---|---|
| Runs on | Expo web build, Pixel-7 viewport | Android emulator / iOS simulator |
| Speed | seconds | minutes |
| In CI | yes, this is the point | no — local/manual until it earns it |
| Tests | navigation, IA, list composition, filters, empty states, auth redirects, i18n | reader WebView, PDF, TTS, offline SQLite, keep-awake, deep links, rotation, permissions |
| Cannot test | anything native | nothing, but too slow to gate every PR |

**Rule of thumb:** if the assertion would hold in a browser, it belongs in Lane A. Lane B
is for what genuinely needs the device.

---

## Lane A — make the Playwright suite able to fail, then let CI run it

### A1. Make it hermetic

Today the specs need a live backend, which is why they were never wired into CI. Replace
that with Playwright request interception — installed **before** navigation, unlike a
`page.evaluate` shim, which lands too late.

```ts
// apps/mobile/e2e/fixtures/mockApi.ts
await page.route('**/api/**', route => { /* fixture per path */ })
```

Routes the app calls on the surfaces under test: `/me/library`, `/me/progress`,
`/me/books`, `/me/books/quota`, `/me/library/collections`, `/me/vocabulary/stats`,
`/me/reading/pace`, `/books`, `/authors`, `/genres`.

Two traps, both already hit by hand:
- `/api/books` must return `{total, items}`; `/me/books` returns a bare array. A
  catch-all matching `endsWith('/books')` breaks Discover with
  `Cannot read properties of undefined (reading 'length')`.
- Match longest path first, or `/me/library` swallows `/me/library/shelves`.

Sign-in is `localStorage.setItem('user', …)` — see `AuthContext`. Set it before the
first `goto`, not after. There are now **three** session states to fixture, not two: absent `user`
(no session), a `user` with `isGuest: true` (guest session), and a `user` with `isGuest: false`
(account). Several criteria below differ between the last two, and `POST /auth/guest` must be routed
in the mock — the reader mounts behind `ReaderSessionGate`, which mints on open.

### A2. Delete the always-pass shape

Ban `.catch(() => false)` followed by `toBeTruthy()`. Use `await expect(locator).toBeVisible()`
and let Playwright's own timeout produce a real failure with a trace.

### A3. Assert the contract that actually matters

The specs must encode the IA the owner asked for. **These are the acceptance criteria:**

1. **First book row is visible without scrolling** at 390×844 with ≥8 books. This is the
   single most important assertion in the suite — it is the regression the owner reported,
   and it is measurable: `boundingBox().y < viewport.height`.
2. **Exactly three blocks above the first book**: resume card, search, filter row. No
   shelves, no carousels, no vocabulary card.
3. **No Home tab.** Tab bar for an **account** is `Library · Discover · (+) · Vocabulary · Profile`.
   The `(+)` upload tab is capability-gated (`canUpload`), so with a guest session or no session at
   all the bar is `Library · Discover · Vocabulary · Profile` — assert both shapes, not one.
4. `/` redirects to `/library` **only for a real account**; a guest session *and* no session both go
   to `/search` (Discover). Since guest sessions shipped, "signed in" and "guest" are no longer
   opposites: a guest holds tokens and `isAuthenticated` is true for them. The redirect keys on
   `capabilitiesFor(user).isAccount` (`app/(tabs)/index.tsx`) precisely so a first launch does not
   land on an empty Library. Three cases to cover: **no session**, **guest session**, **account**.
5. Sign-in lands on Library, never Profile.
6. **One merged list** — a catalog book and an upload appear together; no `Saved`/`Uploads` tabs.
7. Source / sort / layout live in the View sheet, and switching source filters the list.
8. Zero books → `FirstBookState` with exactly one primary CTA. Still exactly one — but **which** one
   depends on `canUpload`, and since the 2026-09-06 upload reversal (ADR-014 §3) that is a
   *session* predicate: an account **and a guest** both get *Upload a book* with the catalog as the
   text link underneath; only a device with **no session** gets *Browse free books* primary and *Or
   upload your own book* as the link (which routes to sign-in). Assert "exactly one primary" in all
   three, and the label per capability.
9. Every route reachable from the tab bar renders without an ErrorBoundary.
10. **No dead routes**: every tappable book row navigates to a screen that is not `+not-found`.

Criterion 10 would have caught both P0s on its own.

### A4. Wire into CI

Add to the `mobile` job (it already installs deps and now bundles). Replace the comment at
`ci.yml:112` with the honest scope: *tests the JS layer, not native; native lives in Maestro.*

---

## Lane B — Maestro on the emulator

Maestro is installed. Nothing else exists yet.

```bash
cd apps/mobile
npx expo run:android          # or run:ios — needs a dev build, not Expo Go
maestro test .maestro/reader-resume.yaml
```

Put flows in `apps/mobile/.maestro/`. Start with the four that are native-only and where
this week's real damage was:

1. **`reader-resume.yaml`** — open a book, scroll, kill the app, reopen. Assert it returns
   to the same place. This is the one that matters: progress persistence broke in six
   distinct ways and every one was invisible to a browser.
2. **`offline-read.yaml`** — download a book, enable airplane mode, read, restore network.
   Assert progress survived. Offline saves were failing 100% and nothing noticed.
3. **`pdf-open.yaml`** — open a PDF, note the page, leave, reopen from the library card.
   Assert it resumes on that page and the button reads *Continue Reading*.
4. **`rotate.yaml`** — rotate mid-chapter, assert the position holds. **Currently expected
   to fail** — the position is a raw pixel offset, and the app is portrait-locked. Write it
   anyway: it is the acceptance test for the position-model work in flight.

Also worth a flow: keep-awake (screen does not sleep mid-page) — shipped guarded and never
verified on a device.

The manual scenarios in `docs/qa/scenarios/` are the source material; `QA-001-reading-progress.md`
and `QA-004-bookmarks-autosave.md` map almost one-to-one onto flows 1 and 3.

---

## What changed this week — the specs assume a UI that no longer exists

Anyone updating Lane A should know the current specs reference removed things:

- **Home tab deleted.** `navigation.spec.ts` `home tab loads with books` targets `/`, which
  is now an auth-aware redirect.
- **Saved/Uploads tabs deleted** — one merged list, source is a filter in the View sheet.
- **Sort chips deleted** — sorting moved into that sheet.
- **Shelves deleted** — Recently added / Quick reads / Finished this month are gone, and
  so is `/library/shelf/[shelfId]`.
- **Profile is now a visible tab**; it used to be reachable only from the Home header avatar.
- Progress percentages were reset, so a fresh account shows empty bars until each book is
  opened once. Fixtures must not assume a stored percentage.
- **Guest sessions exist (2026-09-06).** Opening a book mints one. "Signed out" now means *no
  session*; a guest is a session, and most `/me/*` calls succeed for it. Any spec that used
  "signed out" as shorthand for "no tokens" needs rereading against
  [ADR-014](../01-architecture/adr/ADR-014-guest-sessions.md). What is still account-only: AI,
  identity editing, account deletion, silent sign-out.
- **Guest upload opened (2026-09-06, ADR-014 §3 reversed).** A guest can upload one book on the
  `Guest` tier (50 MB) — the `+` tab, `/my-books/upload` and the Profile *Upload space* row are all
  live for them. The remaining refusal is the sessionless device, which mobile only produces before
  the first book is opened. Any spec asserting "a guest tapping `+` lands on sign-in" is now
  backwards.

---

## Definition of done

- `pnpm -C apps/mobile test:e2e` passes locally with no backend running.
- Every one of the ten criteria in A3 is asserted by a named test.
- Deliberately break one thing (re-add a shelf, or point a book row at a dead route) and
  confirm the suite goes red. A suite that has never failed has not been tested.
- The `mobile` CI job runs Lane A.
- At least flows 1–3 of Lane B run green on an emulator; flow 4 is committed and expected
  to fail, with the reason in a comment.
