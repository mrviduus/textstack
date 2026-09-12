# QA-006: The assistant handoff, and eight fixes nobody has seen

**Area**: MCP connect key, Insights, Tutor, Genres, Guest merge, Progress, Sentry
**Priority**: High — nine PRs shipped to production on 2026-09-11/12 and **not one of these screens
has been looked at by a person**
**Platform**: Android emulator (or device). §4 and §8 have a web half worth checking too.
**Last Tested**: never
**Status**: Not run

---

## Why this scenario exists

Nine PRs (#601–#609) went to production in one day. Every one of them is covered by unit or
integration tests, and **none of the screens they changed has been opened by a human**. That gap is
not an oversight, it is structural:

- `apps/mobile/vitest.config.ts` is narrowed to `src/lib/**/*.test.ts`, so no component or screen
  test runs at all. Everything I asserted about a mobile screen is an assertion about a projection
  function, not about what renders.
- A Tutor session needs an account with vocabulary **and** a live LLM call. There is no OpenAI key
  in the local `.env` (it is stale — local `/explain` answers 503), so the only place the Tutor can
  be exercised is against **production**.
- The guest-merge warning needs a state that cannot be constructed by clicking: a guest whose data
  collides with an account's, or a guest token that has expired.

So this scenario exists for the same reason QA-005 did: the automated lanes cannot reach any of it.

---

## Preconditions

### Emulator setup — read this first, it has cost an hour before

- [ ] `emulator` and `adb` are **not on PATH**: `~/Library/Android/sdk/emulator/emulator`,
      `~/Library/Android/sdk/platform-tools/adb`. Known AVDs: `Pixel_7_Pro`, `Medium_Phone_API_36`.
- [ ] **Uninstall any Play build first**: `adb uninstall app.textstack.mobile`. A store build
      (versionCode 26/27) blocks a local one with `INSTALL_FAILED_VERSION_DOWNGRADE`, and the
      signatures differ anyway.
- [ ] Build and install: `cd apps/mobile && ANDROID_HOME=$HOME/Library/Android/sdk npx expo run:android`
      — **without `--device`**. Passing `--device emulator-5554` fails with `Could not find device`.
- [ ] Load the bundle: `adb reverse tcp:8081 tcp:8081`, then
      `adb shell am start -a android.intent.action.VIEW -d "textstack://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"`
- [ ] **A LogBox toast from `window.onerror` swallows taps.** If a toolbar tap seems to do nothing,
      dismiss the toast first.

### Which JS you are testing, and why it matters

A dev build serves JS **from Metro**, i.e. your working tree — which is what you want here. It does
**not** receive the OTA: an EAS update is keyed to the runtime fingerprint of a release build, and a
dev build's differs. So:

- Testing today's code → dev build, as above. ✅ what this scenario assumes.
- Testing *what a tester actually has* → install build 26/27 from Play and let it pull the
  `production` channel update (group `30b0dd44`, commit `be17e779`). Note §7 then behaves
  differently: Sentry is **enabled** in a release build.

### State

- [ ] **Fresh install, no session**: `adb shell pm clear app.textstack.mobile`.
- [ ] The app points at **production** by default. Keep it there — the server halves of all nine PRs
      are deployed, and the local API has no OpenAI key.
- [ ] An account with **at least 4 saved vocabulary words** (§3 needs a plan with several items, and
      distractors come from the reader's own words).
- [ ] An account with **at least one uploaded book that has chapters** (§2, §5).
- [ ] An unused email for §8b.

---

## §1 — Genre screen: the one that was actually broken

Opening any genre with books threw `Cannot read property 'map' of undefined` for a year, because the
endpoint never sent `authors` and the screen mapped over them. Server fixed in #607; the client half
is a guard.

- [ ] **1a.** Discover → open any genre (e.g. Adventure).
      **Expect**: the book grid renders, and **each card shows an author** under the title.
      *Before #607 this screen rendered nothing at all.*
- [ ] **1b.** Open three more genres, at least one with many books.
      **Expect**: no blank screens, no missing-author cards.
- [ ] **1c.** Compare with web: `https://textstack.app/en/genres/adventure` should now show a
      **"Popular authors in Adventure"** section. It has been silently empty since it was written.

**If 1a fails**: capture the LogBox message verbatim. A `map` error here means the server half
regressed; check `curl -s https://textstack.app/api/genres/adventure | jq '.editions[0]'`.

---

## §2 — Insights: the конспект, its date, and removing one

Needs at least one insight to exist. There is no UI to create one — it arrives over MCP — so do §6
first, or ask for one to be seeded.

- [ ] **2a.** Open a book that has an insight → scroll to **"What you've worked out"**.
      **Expect**: each note shows the chapter label in caps, **a date (YYYY-MM-DD)**, the question,
      and the body.
- [ ] **2b.** The date should be *when the note was last written*, not when the conversation began.
      Re-run the same `save_insight` for that chapter from your assistant, reload the screen.
      **Expect**: the same single row, with today's date — replaced, not duplicated.
- [ ] **2c.** Tap the **×** on a note.
      **Expect**: the row disappears immediately; reload the screen and it is still gone.
- [ ] **2d.** Delete the **last** note on a book.
      **Expect**: the whole section disappears — it renders nothing when empty, by design.
- [ ] **2e.** Turn airplane mode on, tap **×**.
      **Expect**: the row **stays** (the delete failed; it is still on the server). This is the
      honest outcome and the one the test pins — a row that vanishes on a failed delete is a lie.

---

## §3 — Tutor: the exercise type now changes the card

Until #606 all three exercise types rendered the same flashcard and the type was a coloured badge.
This is the only section that spends money (one planning call per session).

- [ ] **3a.** Vocabulary → start a Tutor / Smart session.
      **Expect**: a plan appears with a reason per word.
- [ ] **3b.** Walk the session and record, for each card, the badge and what was rendered:

      | badge | expected card |
      |---|---|
      | `recognition` | **four options**, no sentence prompt |
      | `recall` | **flashcard** — flip and grade yourself, no options |
      | `context` | **four options** AND the sentence with the word blanked out |

      **Expect**: the badge and the card agree on every single item. A `recall` card with four
      options, or a `context` card with no blanked sentence, is the defect this shipped to fix.
- [ ] **3c.** On a `context` card, read the prompt sentence.
      **Expect**: the answer word is **not visible** inside it. A cloze that contains its own answer
      is worse than no cloze.
- [ ] **3d.** Check the four options on any MC card.
      **Expect**: exactly four, no duplicates, and the answer appears once. Distractors should be
      words you have actually saved, where you have enough of them.
- [ ] **3e.** Answer a card wrong, finish the session.
      **Expect**: the re-plan surfaces that word again; the session ends with a reading nudge.

---

## §4 — Mark as finished: one locator, both clients

Mobile used to write `scroll:<lastSlug>:0` where web wrote the end sentinel, so a book marked
finished on the phone **reopened at the top of its last chapter**.

- [ ] **4a.** Library → long-press / menu on a catalog book → **Mark as finished**.
      **Expect**: the card shows finished (100% / a finished marker).
- [ ] **4b.** Open that book.
      **Expect**: it does **not** dump you at the start of the last chapter as if you had just
      arrived there. (Before #602 it did.)
- [ ] **4c.** Mark the same book **unfinished**, reopen.
      **Expect**: back at the beginning, percentage cleared.
- [ ] **4d.** Web cross-check: mark a different book finished at `https://textstack.app`, then open
      it on the phone. The two clients should agree on what "finished" means.

---

## §5 — Progress written from somewhere else (the MCP loop)

This is the feature the whole month was for: tell the assistant you finished a chapter elsewhere and
the app should agree. Requires §6.

- [ ] **5a.** Note where a book currently resumes (open it, see the chapter).
- [ ] **5b.** From your assistant: *"I finished chapter 2 of <book> in the audiobook."*
      The assistant should call `set_book_progress`.
- [ ] **5c.** Reopen the book on the phone (pull to refresh the library first).
      **Expect**: it resumes at the **start of chapter 3**, not back in chapter 2, and the library
      card's percentage has moved.
- [ ] **5d.** Ask the assistant *"where am I in <book>?"* (`get_book_progress`).
      **Expect**: chapter 3, agreeing with the screen.
- [ ] **5e.** Ask it to record a chapter that does not exist.
      **Expect**: it reports a failure. It must **not** claim success — a silent save of an invented
      slug was one of the defects fixed in #601.
- [ ] **5f.** Ask *"what am I reading?"* (`get_my_reading`, takes no arguments).
      **Expect**: your shelf **with titles**, both uploads and catalog books, and books you have
      never opened listed separately.

---

## §6 — Connect key on the phone

- [ ] **6a.** Profile → **Connect assistant** (signed in).
      **Expect**: the screen renders; a key list (probably empty) and a create button.
- [ ] **6b.** Create a key.
      **Expect**: the key is shown **once**, in a panel that stays put, with copy buttons for the key
      and for the Claude Desktop config. It must not disappear behind a toast.
- [ ] **6c.** Copy the config, paste it into Claude Desktop, restart it, ask *"what am I reading?"*
      **Expect**: the shelf comes back. This is the end-to-end proof the whole feature exists for.
- [ ] **6d.** Reload the connect screen.
      **Expect**: the key is listed by its prefix, and says **used recently** rather than never.
- [ ] **6e.** Revoke it, ask the assistant again.
      **Expect**: it can no longer read anything.
- [ ] **6f.** Signed **out**: open the same screen.
      **Expect**: an invitation to sign in, not an error and not a create button.

---

## §7 — Sentry sends nothing from a dev build

- [ ] **7a.** With the dev build running, cause a handled error (open a genre while offline, or any
      LogBox error).
- [ ] **7b.** Check `https://textstack.sentry.io/issues/?query=is%3Aunresolved&statsPeriod=24h`.
      **Expect**: **nothing new**, and specifically nothing tagged `environment: development`.
      Before #608 a laptop's stale key had filed 141 production-looking events this way.
- [ ] **7c.** *(Only if testing a release build)* the same error **should** appear, tagged
      `production`. The rule is "no dev events", not "no events".

---

## §8 — The guest merge warning

The hard one, and the most valuable: the server has reported a skipped merge since guest sessions
shipped, and until #609 **no client read it** — so a reader whose work stayed behind was told *"your
progress was kept"*.

Two ways in. **8b is the reachable one; try it first.**

- [ ] **8a** *(collision path, hard)*. Needs a guest and an account holding a reading session with
      the same `(editionId, startedAt)`. `StartedAt` comes off the request body, so it is
      constructible with two `POST /me/reading/sessions` calls carrying an identical timestamp under
      two identities. See `tests/TextStack.IntegrationTests/GuestMergeConflictTests.cs` for the exact
      shape.
- [ ] **8b** *(expired-token path, reachable)*. Read something as a guest, then let the guest access
      token expire (or hand-edit it to be invalid in SecureStore), then sign in to an existing
      account.
      **Expect**: sign-in succeeds, and a toast says **what you read before signing in stayed on the
      previous session**. It must **not** say your progress was kept.
- [ ] **8c.** The ordinary path, as a control: read as a guest, sign in normally with a valid token.
      **Expect**: the reassurance toast ("progress kept") and the data actually present — no warning.
- [ ] **8d.** Web half: same two cases at `https://textstack.app`. The two toasts are mutually
      exclusive there by construction (`authToastFor`), so seeing both at once is a defect.

---

## What this scenario deliberately does not cover

- **`get_book_progress` / `set_book_progress` against an uploaded PDF read in Original layout.** Its
  position lives in page coordinates and the assistant writes a scroll locator; declaring the space
  moves the book between coordinate systems and costs that reader their page. It is written up in
  `assistant-handoff.md` and is a product decision, not a bug to find here.
- **The catalog progress path's lack of `LocatorKind`.** Deliberately not built — the guard would
  refuse the mark-as-read sentinel it was meant to protect.
- **Insight categories.** Not built; the owner's retrieval is per-book. See
  `assistant-handoff.md`.

---

## If something behaves oddly

- **A screen renders nothing at all** — check LogBox first. Every section above except §1 assumes the
  screen renders; §1 is the one where "nothing" was the actual bug.
- **The assistant says it cannot find a book** — it is probably holding the wrong id. `bookId` is an
  upload, `editionId`/`slug` is a catalog book, and only `get_my_reading` hands out either.
- **An insight will not delete** — check you own it. The endpoint answers 404, not 403, for someone
  else's id, so a wrong id looks like a missing note.
- **The Tutor session will not start** — it is account-only and costs an LLM call. A 403
  `account_required` means you are signed in as a guest.
- **Progress written by the assistant does not show** — pull to refresh. The library card caches, and
  the reader resumes from what it fetched on mount.
