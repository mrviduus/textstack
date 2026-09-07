# QA-005: Guest Loop — reading, saving and converting with no account

**Area**: Auth, Reader, Vocabulary, Profile
**Priority**: Critical — this is the feature the PR exists to deliver
**Platform**: Android emulator (or device). Nothing here is testable on web.
**Last Tested**: 2026-09-06 (Android emulator)
**Status**: Run — see `docs/qa/reports/2026-09-06-android-guest-loop.md`

---

## Why this scenario exists

Mobile now mints an anonymous **guest session** on demand, so a reader can complete the whole
loop — read a book, tap a word, save it, see it in Vocabulary, review it — without ever creating
an account. Registering later promotes that same server-side row **in place**; logging into an
existing account merges the guest's data into it.

Everything below is here because **no automated lane can reach it**. `apps/mobile` has no component
or hook test runner, its Playwright specs are excluded from CI *and* from `tsc`, and the three
riskiest behaviours in this feature live in `expo-secure-store` write ordering, real network
timing, and React Native gesture handling. The unit tests cover the *decisions*; this covers the
*wiring*.

Read §7 first if anything behaves oddly — several failures below have a known non-obvious cause.

---

## Preconditions

### Emulator setup — read this before starting, it will save an hour

- [ ] `emulator` and `adb` are **not on PATH**. They live at
      `~/Library/Android/sdk/emulator/emulator` and `~/Library/Android/sdk/platform-tools/adb`.
      Known AVDs: `Pixel_7_Pro`, `Medium_Phone_API_36`.
- [ ] **Uninstall any existing build first**: `adb uninstall app.textstack.mobile`.
      A Play build (versionCode 22) blocks a local one (versionCode 1) with
      `INSTALL_FAILED_VERSION_DOWNGRADE`, and the signatures differ anyway.
- [ ] Build and install:
      `cd apps/mobile && ANDROID_HOME=$HOME/Library/Android/sdk npx expo run:android`
      — **without `--device`**. Passing `--device emulator-5554` fails with
      `Could not find device with name`.
- [ ] Load the JS bundle: `adb reverse tcp:8081 tcp:8081`, then
      `adb shell am start -a android.intent.action.VIEW -d "textstack://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081"`
- [ ] The app points at **production** by default. That is fine and intended here — the guest
      endpoints are live. No login is needed to reach the catalogue.
- [ ] **A LogBox toast from `window.onerror` swallows taps.** If taps on the reader toolbar seem
      to do nothing, dismiss the toast first. This has cost time before.

### State

- [ ] **Fresh install, no session.** If reusing an emulator, clear app data
      (`adb shell pm clear app.textstack.mobile`) — a leftover guest session invalidates §1 and §2.
- [ ] Have an unused email ready for §4 (registration).
- [ ] Have a **second, existing** account with at least one saved vocabulary word for §5 (merge on
      login). The prod QA account is in the project memory note on mobile QA.
- [ ] Ability to watch traffic (Charles, mitmproxy, or a small local proxy behind `adb reverse`) for
      §1 step 3, **§4b** and §6. Without it, those steps cannot be verified — say so in the results
      rather than ticking them. §4b in particular has no on-screen tell: the request log is the only
      thing that distinguishes a real run from a wasted hour.

---

## 1. Cold start — a session appears without anyone asking

1. Launch the freshly installed app.
2. Observe the first screen.
3. Open any book from Discover. **Watch the network.**

**Verify**:
- [ ] The first screen is **Discover**, not Library, and not a sign-in wall.
- [ ] No language question, no onboarding screen, no account prompt on launch.
- [ ] Opening the book fires **exactly one** `POST /auth/guest`. Not zero, not two.
- [ ] Any blank/loading frame before the reader is **imperceptible**. If you can see it as a
      distinct state, note how long it lasted — the gate budget is 3s and it should never be spent
      on a working connection.
- [ ] The book opens and is readable.

> The gate is designed so `isAuthenticated` cannot flip while the reader is mounted — a flip
> re-fetches the book and re-derives the chapter list. A visible reload here is a real defect.

---

## 2. First word tap — the language question, in place

1. In the open book, **long-press** a word.
2. Observe the selection toolbar.
3. Tap the row where a translation would normally appear (or the Translate button).
4. Answer the language question.

**Verify**:
- [ ] The toolbar shows a **Save** button. (Before this work it was absent for a reader with no
      account, while the coachmark promised it.)
- [ ] Because no language is chosen yet, the inline gloss is replaced by a tappable line asking
      the question — **not** silence.
- [ ] Tapping it opens the translation sheet **without leaving the book**.
- [ ] The sheet shows the pressed word, the question, and a searchable language list.
- [ ] **No translation request has been sent yet** — the question comes first.
- [ ] Picking a language is a **single tap** (no separate confirm step).
- [ ] The sheet immediately becomes a normal translation sheet and the translation **lands in the
      chosen language**.
- [ ] You are still on the same page of the same book.
- [ ] Long-press another word: the inline gloss now appears directly. The question does not return.

**Device-only checks in this step:**
- [ ] The language list **scrolls** inside the sheet. (A `FlatList` inside a `Modal` is a known
      React Native gesture pass-through hazard.)
- [ ] The sheet is usable on a **small screen** — `styles.sheet` has no `maxHeight`. Try a long
      multi-word selection, which is the worst case. Force one with
      `adb shell wm size 720x1280 && adb shell wm density 280` (reset with `wm size reset`).
      *Landscape is **not applicable**: `apps/mobile/app.json` sets `"orientation": "portrait"`, so
      the app does not rotate — `settings put system user_rotation 1` changes nothing.*

---

## 3. Save → Vocabulary → Review — the loop closes

1. With a language chosen, long-press a word and tap **Save**.
2. Go to the **Vocabulary** tab.
3. Start a review session and answer one card.
4. Return to the book and save two or three more words.

**Verify**:
- [ ] Saving gives feedback (haptic + toast) and the word is marked as saved in the toolbar.
- [ ] The Vocabulary tab shows the word. It must **not** show a red "Couldn't load your library"
      with a Retry button — that was the old signed-out behaviour and its return is a regression.
- [ ] A review card renders and can be answered.
- [ ] The Stats screen shows a signed-in-shaped screen, not an error.

---

## 4. Register — the merge, in place. **This is the headline assertion.**

1. Note exactly what you have accumulated: which words, which book, how far you read.
2. Profile → **Create free account** → register with the unused email.
3. Return to Vocabulary, Library and the book.

**Verify**:
- [ ] Every saved word is still there.
- [ ] Reading progress on the book survived.
- [ ] The chosen native language survived — long-press a word, the gloss is in that language, and
      you are **not** asked again.
- [ ] Profile now shows the account, and the guest banner is gone.

### 4b. The path that used to lose everything — do not skip this

The bug this guards was invisible: registration answered *success* and silently discarded the data.
It only appears when the access token has expired, which takes an hour.

1. Fresh install, become a guest, save a word (§1–§3). Note the mint time.
2. **Kill the app** and leave it closed for **over an hour** (access tokens live 60 minutes).
3. Reopen and reach the register form by a route that makes **no authenticated call**:
   Discover → **Ask the librarian** → its sign-in wall → **Register**. Measured at zero requests.

   **Not via Profile.** That screen fetches `/me/books/quota` itself, which 401s on the stale token
   and fires `POST /auth/refresh-mobile` — about two and a half minutes before the register button
   is reachable. The expired-token condition is destroyed on the way to the form, and nothing on
   screen says so, so an hour of waiting proves nothing. This is how the first run of this step went
   (D2).

**Verify**:
- [ ] **Before pressing Create account, confirm from the request log that no `refresh-mobile` has
      fired.** Without that line the run is worthless — and it is not observable from the screen.
      This check is the step; the rest is setup.
- [ ] Registration succeeds **and the saved word is still there.**
- [ ] The account's `createdAt` equals the guest mint time — proof the row was promoted, not copied.

> If the word is gone, the merge did not fire. That is critical.
> A proactive `refresh-mobile` immediately before `register` (no 401 preceding it) is **correct** —
> that is `packages/shared/src/api/tokenExpiry.ts` keeping an expired bearer off the merge call.

---

## 5. Login into an existing account — the other merge path

1. Fresh install, become a guest, save a word and read a few pages (§1–§3).
2. Sign in to the **existing** account that already has its own vocabulary.

**Verify**:
- [ ] The guest's word **and** the account's pre-existing words are both present.
- [ ] Reading progress: the more recently updated one wins (this is last-write-wins by design).
- [ ] The account's own native language is **unchanged** — the guest's choice must not overwrite a
      language the account had already set.
- [ ] Sign-in returns 200, not 500. A 500 here means a merge conflict rolled the transaction back
      and would repeat on every retry.

---

## 6. Things that are meant to be closed

> **Changed 2026-09-06 — upload is no longer one of them.** ADR-014 §3a reversed it: a guest may
> upload one book on the `Guest` tier (50 MB). The two upload checks below are inverted from the
> version this scenario was first run against, and the run table further down still records the old
> expectation as a pass. That row is history, not a target.

**Verify**:
- [ ] The **upload tab IS visible** to a guest (the `+`), and tapping it opens the add sheet rather
      than the sign-in screen. It is still hidden with **no session at all** — a fresh install that
      has not yet opened a book — which is now the only case that gets the wall.
- [ ] Library with zero books shows one primary CTA, and for a guest it is now **Upload a book**,
      with the catalog as the text link underneath. **Browse free books** as the primary is correct
      only for a device with no session.
- [ ] A guest's Profile shows the **Upload space** row (`0 B / 50.0 MB`) — this was filed as a defect
      when the allowance was unspendable, and is deliberate now that it is not.
- [ ] A guest upload actually completes: pick an EPUB, it parses, and it opens in the reader. The
      **second** one must be refused by the server (`MaxBooks: 1`), not by the client — check the
      refusal is legible and not a silent failure.
- [ ] **Librarian** and **Tutor** show a sign-in invitation, not an error — and opening them does
      **not** fire a model call. Watch the network: a paid request before the wall renders is a
      defect that existed until recently.
- [ ] **Ask this book** shows its sign-in state.
- [ ] Translation, dictionary and TTS **still work** — these are deliberately open to guests and
      the reading loop depends on them. Breaking them is the over-correction to watch for.

---

## 7. Failure modes with known non-obvious causes

- [ ] **Airplane mode, downloaded book.** The book must have been through the explicit **Download
      for Offline** action first. *Reading a chapter online does not make it available offline* —
      a book you have merely read shows "This chapter isn't available offline", and the case then
      fails for a reason that has nothing to do with the gate. Also stop any logging proxy:
      `adb reverse` is a loopback forward through adbd and keeps working with the radio off, so
      airplane mode alone does not take the app offline.
      With a downloaded book, the reader must open in about a second — **not** after a 3-second
      pause. The gate
      is designed to give up immediately when the network fails outright; spending the full budget
      means it is waiting on something it should not.
- [ ] **Rate-limited first launch.** `POST /auth/guest` is limited per IP. If you install several
      times in a few minutes you may get no session at all. Correct behaviour: **the book still
      opens** (signed-out, degraded). The gate must never be able to hide a book.
- [ ] **Sign-in while a book is opening.** Start opening a book and, from another screen, sign in
      during that window. Then confirm the app is in a coherent state — signed in, reader works,
      no repeated 401s. This exercises the interleaved-token-write path; the unit tests cover the
      decision, not `expo-secure-store`'s actual write ordering.
- [ ] **Sign out while the profile is refreshing.** Sign out immediately after a screen that
      fetches the profile. Then open a book. It must mint a **new** guest session and work — not
      sit in a 401 loop. (Symptom of the bug: a user appears present but every request fails.)
- [ ] **Guest Sign Out.** Profile → Sign out as a guest must show a **destructive confirmation
      naming what is lost**, not a plain "are you sure". Cancelling must change nothing. Confirming
      is genuinely irreversible — use a throwaway guest for this.
- [ ] **An account with no native language** still gets the full-screen `onboarding/language`
      route. Only guests and session-less readers are asked inside the sheet.

---

## Results

| Check | Expected | Actual |
|-------|----------|--------|
| First screen | Discover, no wall | **Pass** — Discover, no onboarding, no account prompt |
| `POST /auth/guest` on first book | exactly 1 | **Pass** — exactly 1, on two independent fresh installs (134 ms / 100 ms) |
| Save button for a guest | present | **Pass** |
| Language question | in the sheet, book not left | **Pass** — no `/translate` sent before the question; one tap to choose |
| Word → Vocabulary → review | works | **Pass** — no red error; card renders and is answerable; Stats renders |
| Register → word survives | yes | **Pass** — 3/3 words, progress, language; account `createdAt` = guest mint time |
| **Register after >1h idle → word survives** | **yes** | **Pass on the retry.** Via Profile the token is refreshed before the form is reachable (D2), so that run proved nothing. Re-run via Discover → Ask the librarian → Register, token 21 min expired: app fired `refresh-mobile` proactively, then `register` 200, word survived, `createdAt` = guest mint |
| Login into existing account | both sets present, no 500 | **Pass** — 200; 5 words; account's `fr` not overwritten by guest's `ru` |
| Upload tab for a guest | hidden | **Pass** — *expectation reversed 2026-09-06, ADR-014 §3a; do not re-assert* |
| Librarian/Tutor | wall, and no model call | **Pass** — zero requests of any kind |
| Translate / dictionary / TTS | still work | Translate + TTS **pass**. Dictionary returns 503 in ~3.0 s — **upstream outage**, not ours |
| Airplane mode, cached book | opens ~1s | **Pass, ~0.5 s** — but only for an explicitly *downloaded* book; reading online does not cache |
| Rate-limited, no session | book still opens | **Pass** — 429 then chapter 68 ms later. Save in that state prompts for an account with an explicit "this one wasn't kept" toast |
| Guest sign out | destructive confirm | **Pass** — names what is lost; cancelling changes nothing |

---

## Actual Issues Observed

| Date | Issue | Status |
|------|-------|--------|
| 2026-09-06 | ~~**D1** — word saved while rate-limited is silently discarded~~ | **Withdrawn** — tester error. The toast ("Saving words needs an account — this one wasn't kept") fires for 3.6 s; screenshots were taken after it expired |
| 2026-09-06 | **D2** — §4b cannot reach its own bug via the Profile route; Profile refreshes the token first | **Closed** — §4b above now routes through Discover → Ask the librarian → Register and requires the request log to show no prior `refresh-mobile` |
| 2026-09-06 | **D3** — Blitz review style is selected and persisted but the session still runs Flashcards | **Fixed** — [#558](https://github.com/mrviduus/textstack/issues/558) in [#562](https://github.com/mrviduus/textstack/pull/562) |
| 2026-09-06 | **D4** — Flashcards mode fetches a dictionary definition it structurally cannot display | **Fixed** — [#559](https://github.com/mrviduus/textstack/issues/559) in [#562](https://github.com/mrviduus/textstack/pull/562) |

---

## Test History

| Date | Tester | Result | Notes |
|------|--------|--------|-------|
| 2026-09-06 | Claude (emulator) | Loop holds; 0 defects in the guest loop, 3 elsewhere (D2 scenario, #558, #559); D1 withdrawn | Pixel 7 Pro (API 17) + Medium_Phone_API_36, prod backend, local debug build. Traffic captured through a logging proxy. Not run: haptics, landscape (app is portrait-locked), the two true interleave races, real hardware |
