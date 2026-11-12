# QA-005 Guest loop — Android emulator pass

**Date:** 2026-09-06 · **Build:** local debug (`expo run:android`), versionCode 1, JS from Metro ·
**Backend:** production · **Devices:** Pixel 7 Pro emulator, Android 17 (`sdk_gphone16k_arm64`,
1440×3120) and Medium_Phone_API_36, Android 16 (1080×2400) · **Scenario:**
`docs/internal/qa/scenarios/QA-005-guest-loop.md`

Traffic was observed for every step. The app's `EXPO_PUBLIC_API_URL` was pointed at a local
logging proxy (`adb reverse` → node → `https://textstack.app`), so every line below is a real
request/response pair with its status and duration, not an inference. Screen timings come from
`screenrecord` at 10 fps, measured by dark-pixel fraction per frame.

---

## Verdict

**The loop holds.** A reader with no account reads, taps a word, is asked their language in
place, saves, reviews, and converts — and registration promotes the same server row rather than
copying it. The headline assertion is proven by data, not by inspection: the account's
`createdAt` is the timestamp of the guest mint.

**§4b passes on the second attempt, for the right reason.** The first run could not reach the bug —
the Profile route refreshes the token on the way to the form (**D2**, a defect in the scenario). Re-run
through a route that makes no authenticated call, with a token 21 minutes expired, the app refreshed
proactively before registering and the word survived.

**No defect remains in the guest loop itself.** What I first filed as D1 — a word silently lost when
the guest mint is rate-limited — was my own measurement error and is withdrawn below; the app shows
a clear toast saying the word was not kept. Two defects found while here are unrelated to guests and
are filed as [#558](https://github.com/mrviduus/textstack/issues/558) (**D3**) and
[#559](https://github.com/mrviduus/textstack/issues/559) (**D4**).

---

## What was covered, and what was not

Run in full: §1, §2, §3, §4, §5, §6, and five of the six §7 cases.

**Not run, and why:**

- **Haptic feedback on save** — cannot be observed on an emulator. The visible half (toolbar
  state change, inline gloss) was confirmed; the haptic was not.
- **Landscape (§2)** — **not applicable.** `apps/mobile/app.json` sets `"orientation": "portrait"`,
  and `settings put system user_rotation 1` did not rotate the app. The case cannot occur.
- **A true interleave of sign-in with an in-flight guest mint, and of sign-out with an in-flight
  profile fetch (§7)** — could not be driven. Both need two screens at once; adb drives one. The
  mint answers in ~100 ms, far shorter than the several seconds it takes to type credentials. Only
  the **post-conditions** were verified (below), not the race itself.
- **Real hardware** — emulator only. No Galaxy, no physical device.

---

## §1 Cold start — one mint, no wall

First screen is **Discover**. No language question, no onboarding, no account prompt.

`POST /auth/guest` fires **exactly once**, on opening the book — not on launch, not twice.
Confirmed on two independent fresh installs:

```
08:19:45.992  POST /api/auth/guest -> 200 134ms
08:37:07.812  POST /api/auth/guest -> 200 100ms
```

Every `/me/*` call after it carries `Authorization`. The book opens and is readable.

One request before the mint is worth noting: the **book detail screen fires
`GET /me/library/collections` with no session and takes a 401**. Harmless, but it is a wasted
round trip on the busiest screen before the reader.

### The gate's visible cost

The scenario asks whether the blank frame before the reader is imperceptible. It is not zero, and
the number depends on the emulator, so both are given.

| open | device | blank/spinner |
|---|---|---|
| cold process, **needs a mint** | Pixel 7 Pro | **0.5 s** (t=2.0 → 2.5) |
| cold process, **session already present** | Pixel 7 Pro | 0.1 s (one frame) |
| warm, session present | Pixel 7 Pro | none detectable at 10 fps |
| cold process, **needs a mint** | Medium_Phone_API_36 | 2.9 s (t=2.3 → 5.2) |

I first measured 2.9 s and was about to call it "the gate spends its whole budget". Re-running the
cold-mint case on the **same AVD as the control** put it at 0.5 s, so the 2.9 s belongs to the
slower emulator image, not to the gate. The mint itself answered in 100–134 ms in every run, and
the chapter arrived ~0.2 s after the tap. **The gate is not waiting on the network**, and on the
faster image it costs about half a second over an open that needs no mint.

---

## §2 First word tap — the question, in place

All checks pass.

- The toolbar shows **Save** for a guest.
- The gloss row is replaced by a tappable **"What language do you know best?"** — not silence.
- Tapping it opens the translation sheet **without leaving the book**, showing the pressed word,
  the question, and a searchable list. **No `/translate` had been sent at that point** (empty
  request log).
- Picking a language is **one tap**. `PUT /me/profile` → 200, then the sheet becomes an ordinary
  translation sheet: `motorcar → voiture` (fr), `Cercle → Круг` (ru). Same page, same book.
- Long-pressing another word shows the gloss directly; the question does not return. Confirmed on
  both devices and both languages.
- The language list **scrolls inside the modal** — the `FlatList`-in-`Modal` hazard did not bite.

**Small screen** (forced to 720×1280 @ 280 dpi): the sheet is still usable — header, word,
question, search and ~3 rows visible, list scrolls. The **selection toolbar labels clip**, though:
"Copy" renders as "Cop", "Explain" as "Explai", and the question line truncates to "What language
do you know be…".

---

## §3 Save → Vocabulary → Review

- Save gives visible feedback: `POST /me/vocabulary/words` → 200, the toolbar switches to
  New/Known/Remove, and the word gains a persistent underline + inline gloss in the text.
- The **Vocabulary tab lists the guest's words** — no red "Couldn't load your library", no Retry.
  The old signed-out behaviour has not returned.
- A review card renders and can be answered (`POST /me/vocabulary/review` → 200); the card
  auto-speaks via `GET /api/tts` → 200.
- **Reading Stats renders fully** for a guest — heatmap, weekly chart, goals, achievements. Not an
  error screen.

---

## §4 Register — the merge, in place

Accumulated as a guest: 3 words (*acquaintances*, *pretended*, *smooth*), *At the Villa Rose*
chapter 1/21 at 2 %, native language French.

```
07:57:19.829  POST /api/auth/register -> 200 434ms  auth=yes
```

`auth=yes` is the point: the register call carried the guest's bearer.

After registering:

- **All three words present**, with translations, sentences and SRS stage intact
  (*acquaintances* still at Recognition from its review).
- **Reading progress survived** — book detail shows 2 % and "Continue Reading".
- **French survived** — long-press gives `thousand → mille`, and the question does not return.
- Profile shows the account, the guest banner is gone, the upload (+) button appears, and
  Smart session (tutor) now works.

**The decisive evidence that the row was promoted, not copied:**

```json
{"email":"qa-guest-a-20260906@textstack.app","isGuest":false,
 "createdAt":"2026-09-06T07:28:26.0683+00:00","nativeLanguage":"fr"}
```

`createdAt` is **07:28:26** — the moment `POST /auth/guest` was answered. Registration happened at
07:57. Same row.

### §4b — the >1h path. Run, but it did not reach the bug.

Fixture: fresh install on the second emulator, guest minted **07:45:35**, one word saved
(*acquaintances → знакомые*), language Russian, app force-stopped **07:49:16**. Reopened
**08:50:26** — 61 minutes closed, access token expired ~5 minutes earlier. Launch fired only the
three unauthenticated Discover calls; the token was still stale.

Then, following the scenario's instruction to go straight to Profile:

```
08:51:26.644  GET  /api/me/books/quota   -> 401 219ms  auth=yes
08:51:26.751  POST /api/auth/refresh-mobile -> 200  84ms
08:51:27.034  GET  /api/me/books/quota   -> 200 204ms  auth=yes
```

**The Profile screen's own quota fetch 401s and refreshes the token** — 2.5 minutes before the
register button is reachable. So the registration that followed carried a *fresh* bearer:

```
08:53:58.316  POST /api/auth/register -> 200 572ms  auth=yes
```

Result of that run: the word survived, `createdAt` = **07:45:35.010** (the guest mint),
`nativeLanguage` = `ru`. All correct — but it does **not** answer the question §4b asks, because
the expired-token condition was destroyed on the way to the form.

This is a defect in the scenario, not in the app — see **D2**. So a second fixture was built and the
step re-run properly.

### §4b, retried by a route that makes no authenticated call — **Pass**

Second fixture: fresh guest minted **08:37:07** on the Pixel, one word saved (*motorcar*), app
force-stopped **08:55:40**. Reopened **09:58:30** — 62 minutes closed, access token expired 21
minutes earlier.

Route: launch → Discover → **Ask the librarian** → its sign-in wall → **Register**. Launch fired
only the three unauthenticated Discover calls, and the librarian wall fired nothing at all, so the
token was **still expired** when the register form was reached. Verified against the request log at
each step, not assumed.

Pressing Create account:

```
10:00:47.186  POST /api/auth/refresh-mobile -> 200  67ms  auth=no
10:00:47.579  POST /api/auth/register       -> 200 337ms  auth=yes
```

**The app refreshed the token of its own accord, before registering — with no 401 to prompt it.**
That is the `packages/shared/src/api/tokenExpiry.ts` guard doing exactly the job it exists for:
the server never saw an expired bearer, so it never had a reason to silently ignore the merge.

Result, read back from the server:

```json
{"email":"qa-guest-d-20260906@textstack.app","isGuest":false,
 "createdAt":"2026-09-06T08:37:07.832372+00:00"}
```

`createdAt` is the guest mint, and the saved word `motorcar` is present. **The path that used to
lose everything now keeps it, and keeps it for the right reason.** This is the assertion §4b was
written to make; the first attempt could not make it, this one does.

---

## §5 Login into an existing account

Guest: 1 word (*motorcar → автомобиль*), native language **Russian**, progress written 08:13:06.
Account A beforehand: 4 words, native language **French**, progress 2.0027 % written 08:00:18.

```
08:15:11.071  POST /api/auth/login -> 200 518ms  auth=yes
```

**200, not 500.** After the merge, read back from the server:

- **5 words** — the guest's `motorcar` alongside the account's four. Both sets present.
- **`nativeLanguage` still `fr`.** The guest's Russian did **not** overwrite the account's French.
- Progress: the row is the **newer** write (`updatedAt` 08:13:06, the guest's). Last-write-wins,
  as designed.

One honest note on that last line: the guest's newer write happened to be at a *shallower* point
in the book (0.31 %, chapter 1) than the account's older 2.00 %, because during setup I navigated
back to chapter 1. So the account's further-along position was replaced by an earlier one. That is
last-write-wins behaving exactly as specified — but it is worth knowing that "newer" and "further"
are not the same thing, and in-book progress otherwise behaves as a high-water mark.

---

## §6 Things that are meant to be closed

| check | result |
|---|---|
| Upload tab hidden for a guest | **Yes** — tab bar is Library / Discover / Vocabulary / Profile; the (+) appears only after registering |
| Library empty state | **Correct** — primary CTA "Browse free books", upload demoted to "Or upload your own book", which leads to the auth screen |
| Librarian | Sign-in wall, **zero requests fired** |
| Tutor (Smart session) | Sign-in wall, **zero requests fired** |
| Ask this book | Sign-in state, **zero requests fired** |
| Translation | Works — `POST /translate` → 200 |
| TTS | Works — `GET /api/tts` → 200, audio plays |
| Dictionary | `GET /api/dictionary/en/{word}` → **503 in ~3.0 s** — upstream outage, not a regression (see below) |

No paid inference is reached before the wall renders on any of the three AI surfaces.

---

## §7 Failure modes

**Guest Sign Out — destructive confirm.** Passes, and the copy is specific: *"Sign out and lose
everything?"* naming the words, highlights and progress that go, with buttons **KEEP READING** /
**SIGN OUT AND LOSE IT**. Cancelling changed nothing — all 3 words still present, SRS stage intact.

**Sign out, then open a book.** A **new** guest is minted and everything works. **Zero 401s** in
the whole sequence.

**Rate-limited first launch.** Deliberately exhausted the per-IP limit (measured: 3 mints per 5
minutes; the 4th returns 429), then opened a book on a fresh install:

```
08:25:26.655  POST /api/auth/guest -> 429 349ms
08:25:26.723  GET  /api/en/books/.../chapters/1-summer-lightning -> 200 27ms
```

**The book opened and was readable 68 ms after the refusal.** The gate cannot hide a book. Pass.

In that state the reader is session-less, so Save prompts for an account rather than saving — with
an explicit toast saying the word was not kept. See the withdrawn **D1** below; I initially misread
this as a silent loss.

**An account with no native language.** Registered an account via the API with `nativeLanguage:
null`, signed in on the device: the **full-screen `onboarding/language` route** appears, not the
in-sheet question. Correct split.

**Sign-in while a book is opening / sign-out while the profile is refreshing.** The races
themselves were not reproduced (see "what was not run"). What was verified: after aborting a book
open mid-gate and then signing in, the app is coherent — signed in, reader works, saved words
render with their glosses, **zero 401s**. After signing out and opening a book, a new guest is
minted and works.

**Airplane mode, cached book.** Run with real airplane mode **and** the logging proxy stopped, so
the app had no route out at all (`adb reverse` bypasses airplane mode on its own, which would have
made the test meaningless).

First finding: **reading a chapter online does not make it available offline.** With airplane mode
on, a book whose chapter had just been read showed *"This chapter isn't available offline —
Download the book for offline reading, or connect to the internet and try again."* Offline reading
requires the explicit **Download for Offline** action; the scenario's phrase "a book whose chapters
are cached" is only satisfied by that, not by having read it.

With the book actually downloaded (21 chapters), offline:

| case | blank window | reader text |
|---|---|---|
| session present (account) | 0.4 s (t=2.6 → 2.9) | 3.0 s, tap at ~2.4 |
| **no session at all** | 0.4 s (t=2.5 → 2.8) | 2.9 s, tap at ~2.4 |

The second row is the one that matters: with no session and no network the gate must attempt a
mint, fail, and get out of the way. **It does — about half a second, not the 3-second budget.**
Chapter navigation also works offline, and the book detail screen degrades to *"You're offline —
showing downloaded content only"* with a "Downloaded — Remove" state.

One dev-only wart on that path: a red LogBox screen appears first — `Failed to load book: ApiError:
Network request failed` from `[slug].tsx:97`. The rejection **is** handled (dismissing it reveals
the correct offline screen underneath) and LogBox does not exist in release builds, so it is noise
rather than a defect — but it does hide a working screen behind a full-screen error during
development.

---

## Defects

### D1 — withdrawn. The session-less Save is handled correctly.

**I got this wrong on the first pass and it is worth recording why.** I reported that tapping Save
with no session did nothing at all — no request, no toast, no state change — and that the word was
silently lost.

The first two claims were an artefact of my method. `ReaderShell.tsx:687` routes the tap through
`saveWordIntent`, which returns `'prompt'` for a session-less reader, and the handler fires a haptic
plus a toast with `duration: 3600`. **My screenshots were taken 4–7 seconds after the tap** — after
the toast had already expired. I read an empty screen as silence.

Re-run with a screen recording, the tap produces this within 200 ms and it stays up for the full
3.6 s:

> **Saving words needs an account — this one wasn't kept. Sign in from Profile.**

That is the right behaviour, and unusually good behaviour: it says plainly that the word was *not*
kept, and points at the way in. `saveWordIntent` is explicit that an unauthenticated save "must
never reach the API — an unauthenticated save is a guaranteed 401 and a lost word", so not sending
the request is the design, not a gap in it.

What survives from the original observation is only this, and it is not a defect: a reader who hits
the guest rate limit is treated as signed-out, so Save asks for an account instead of saving. The
book still opens and reading is unaffected. Worth knowing as product behaviour, nothing to fix.

**Method note for the next pass:** a toast is a 3.6 s window. Screenshot within a second of the tap,
or record the screen — a late screenshot cannot distinguish "no feedback" from "feedback you
missed".

### D2 — §4b cannot reach its own bug through the route it prescribes · **scenario defect**

Going "straight to Profile" is not neutral: the Profile screen fetches `/me/books/quota`, which
401s on the stale token and triggers `POST /auth/refresh-mobile`. By the time "Create free account"
is tappable, the token is fresh and the defect condition is gone. An hour of waiting is spent to
test nothing.

**Fix the scenario to route through a screen that makes no authenticated call:** launch → Discover
→ **Ask the librarian** → its sign-in wall → Register. Measured at zero requests, and it is what
the passing retry above used. Worth adding to §4b: *verify from the request log that no
`/auth/refresh-mobile` has fired before you press Create account* — otherwise the run proves
nothing and there is no way to tell from the screen.

### D3 — the Blitz review style is selected but never applied · **unrelated to guests** · [#558](https://github.com/mrviduus/textstack/issues/558)

Vocabulary → the sliders control → **Review style: Blitz** shows Blitz checked and persists that
across reopening the sheet. Starting Practice nonetheless runs Flashcards: the chip in the review
header reads "Flashcards" and the card is a tap-to-flip, not multiple choice. Reproduced twice,
including once where the server had already classified the card as `multiple_choice` with four
options (confirmed against `GET /me/vocabulary/review`).

### D4 — Flashcards mode fetches a definition it structurally cannot display · **unrelated to guests** · [#559](https://github.com/mrviduus/textstack/issues/559)

`ReviewFeedback` runs its dictionary lookup for every card without a stored definition, then — in
`classic` mode — returns the *mini* feedback branch, which has no definition slot at all. The
fetched value is only ever read in the blitz branch.

Observed: two lookups fired and discarded, each costing the full budget against the dead upstream.

```
08:01:08.587  GET /api/dictionary/en/pretended -> 503 3092ms
08:01:21.790  GET /api/dictionary/en/smooth    -> 503 3030ms
```

Because Blitz cannot be entered (**D3**), this is currently the only mode a user can reach.

---

## The dictionary, and the field binding that was just fixed

The upstream is genuinely down — `api.dictionaryapi.dev` returned nothing in 25 s to a direct
request. Our endpoint answers **503 in 3.0–3.2 s**, exactly as intended. No definition appears in
review, and that is expected, not a defect.

That left the question of whether the repaired `meanings` → `definitions` binding actually renders
when a provider answers. It could be tested, because **one word is still in the server-side
cache**: `GET /api/dictionary/en/hello` returns 200 with `cached: true`, three parts of speech.

What was proven, and what was not:

- **Proven.** Saving `hello` and opening its card showed the full definition — noun, verb and
  interjection senses — rendered from the `definitions` array. So the field name is right and the
  data reaches the UI.
- **Not proven.** That definition came from `card.definition`, which the **server** back-fills at
  save time. The client-side lookup that the fix touched (`dictionaryApi.lookupWord` in
  `ReviewFeedback`) early-returns whenever the card already carries a definition. I built the
  discriminating case — a `hello` card with `definition: null`, in `multiple_choice` mode — but
  could not reach the screen that renders it, because of **D3**.

So: the binding is correct and the data path works; the specific line inside `ReviewFeedback`
remains unobserved, and will stay unobservable until D3 is fixed.

---

## Smaller things, none blocking

1. **"Create free account" opens the auth screen on the *Sign in* tab**, not Register. Every
   converting guest has to notice and switch tabs.
2. **`POST /translate` fires twice per word tap**, ~15 ms apart, both 200. That is a paid
   OpenAI call being made twice for one gloss.
3. **`GET /en/books/{slug}` fires twice** on reader open, ~3 ms apart.
4. **"Password must be at least 8 characters" stays red with 14 characters entered** on the
   sign-in form.
5. **A guest's Profile advertises "Upload space 0 B / 50.0 MB"** although upload is account-only
   by product choice. It offers an allowance the user is not permitted to spend.
6. **Book detail shows "Start Reading" and no progress row immediately after leaving the reader**;
   the next visit shows 2 % and "Continue Reading". A stale read, not lost data.
7. A LogBox toast appeared once — `Error: Uncaught (in promise) Call to function
   'ExpoKeepAwake.deactivate' has been rejected` — triggered by my `wm size` change, not by any
   app action. Dev-build only.

---

## Test data created on production

Four real accounts were registered on prod during this pass, plus the guest rows behind them:

| account | role in the pass |
|---|---|
| `qa-guest-a-20260906@textstack.app` | §4 register-in-place, then §5 merge target (5 words, `fr`) |
| `qa-guest-b-20260906@textstack.app` | §7 "account with no native language" (registered via API with `nativeLanguage: null`) |
| `qa-guest-c-20260906@textstack.app` | §4b first attempt (`ru`, 1 word) |
| `qa-guest-d-20260906@textstack.app` | §4b retry — the passing run (1 word, no language) |

Several short-lived guest rows were also minted and abandoned. `GuestCleanupWorker` will not prune
the ones holding vocabulary; they are unreachable but persistent. Delete the four accounts and those
guests when the findings are closed.

## How this was measured, if it needs repeating

- **Traffic:** `EXPO_PUBLIC_API_URL=http://localhost:8899/api` at Metro start, `adb reverse
  tcp:8899 tcp:8899`, and a ~30-line node proxy forwarding to `https://textstack.app` while
  logging method, path, status, duration and whether an `Authorization` header was present. This is
  what makes claims like "zero requests" and "auth=yes" checkable rather than asserted.
- **Timing:** `adb shell screenrecord --size 720x1600`, frames at 10 fps, dark-pixel fraction of
  the content area per frame. A blank/spinner frame reads ~0 %; rendered text reads 7–12 %.
- **Airplane mode needs the proxy stopped too.** `adb reverse` is a loopback forward through adbd
  and keeps working with the radio off, so airplane mode alone does not take the app offline.
