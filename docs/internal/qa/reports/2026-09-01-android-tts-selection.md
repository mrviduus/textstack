# Android — selection speech, emulator pass

**Date:** 2026-09-01 · **Build:** local debug (`expo run:android`) on the fix branch ·
**Backend:** production · **Device:** Pixel 7 Pro emulator, Android 17 (`sdk_gphone16k_arm64`) ·
**Account:** guest · **Book:** *At the Villa Rose*, chapter I

Triggered by a report from a tester on a Galaxy S24: selecting a sentence and pressing Listen
gave silence, or the wrong thing, depending on timing. Tapping a single word worked.

**No Galaxy S24 was used for this pass.** An emulator is not One UI, and the gesture timing that
made this device-specific is exactly what an emulator cannot reproduce. What it can settle is
message ordering, and that is where all three defects lived. S24 acceptance is still open — see
the checklist at the end.

---

## Verdict

Three defects, all reproduced and all fixed. The reported symptom needed all three explained;
fixing any two would still have shipped something visibly wrong.

---

## Ruled out first: the server

| input | response | bytes | duration |
|---|---|---|---|
| 44 chars | 200 | 22 KB | 3.72 s |
| 375 chars | 200 | 123 KB | 20.52 s |

Whole file, 1.18 s to synthesise. Nothing was being cut off, so "the voice breaks off" was never
about the audio.

## Driving the gesture

`adb shell input swipe` cannot reproduce this. It starts moving immediately, so the finger passes
`DRAG_TOLERANCE` (8 px) and the 450 ms word timer is cancelled before it fires — the gesture under
test never happens. `input motionevent` DOWN / MOVE / UP holds the finger still, which is the whole
point:

```
motionevent DOWN 140 1289 ; sleep 0.7   # past LONGPRESS_MS → word selected
motionevent MOVE 170 1289 ; sleep 0.3
motionevent MOVE 340 1289 ; sleep 0.3
motionevent MOVE 1300 1289 ; sleep 0.4  # past the 220ms selectionchange debounce
motionevent UP  1300 1289
```

---

## D1 — a word spoke itself mid-gesture · **fixed**

Logcat, before the fix:

```
12:18:18.349 [WV] [diag] selected word: travel
12:18:18.350 [diag] setSelection OPEN 'travel' mode= 'tap'
```

That `mode:'tap'` message is posted by the 450 ms long-press — which is also the first frame of the
drag. `ReaderShell` auto-spoke any single-word selection, so the gesture that means "I am choosing a
phrase" began by reading its first word aloud. Auto-speak is removed; speech now only starts from a
button. After the fix the same two lines appear with no `tts_played` following them.

## D2 — the sentence never reached the app · **fixed**

The one that actually decided what got read. After the word was selected, the drag fired
`selectionchange` — and every event landed inside the 1500 ms suppression window the tap path arms,
so all were dropped. The app's selection stayed `travel`.

Pressing Listen therefore did exactly what it was told:

```
12:19:00.690 [analytics] tts_played { language: 'en', kind: 'word' }
```

Confirmed the window was the cause by nudging a selection handle **after** it had expired — the
identical event delivered the sentence immediately:

```
12:20:00.998 [diag] setSelection OPEN 'travel to Aix-les-Bains, in Savoy, where for' mode= 'drag'
```

The release path that should have prevented this (`touchmove` zeroing the deadline once the finger
passes `SELECT_EXTEND_TOLERANCE`) carries the comment *"Needs on-device validation of the
extend-from-tap gesture"*. It does not fire — once Android's selection ActionMode owns the gesture,
the page stops receiving `touchmove` at all.

Timing is why this looked device-specific. The window closed at ≈`12:18:19.849`; the debounced
dispatch would have fired at ≈`12:18:19.82`. Thirty milliseconds. A phone that completes the drag
slightly slower lands on the other side of it and works.

After the fix, same gesture:

```
12:21:50.715 [diag] setSelection OPEN 'travel' mode= 'tap'
12:21:52.028 [diag] setSelection OPEN 'travel to Aix-les-Bains, in Savoy, where' mode= 'drag'
12:23:02.865 [analytics] tts_played { language: 'en', kind: 'sentence' }
```

Visible side effect confirming the state was wrong before: **Ask now appears** in the toolbar. It is
gated on `isMultiWord`, which was false while the selection was still a single tapped word.

## D3 — the wait was invisible · **fixed**

Fetching audio takes about a second, and the button said "Listen" throughout, so the natural second
press cancelled the first fetch. It now shows a spinner labelled "Loading" (`shots/s13.png`), stays
pressable so a download that never lands cannot trap the reader, and the row does not change height.

## D4 — the disabled state was invisible · **fixed during the pass**

Caught by running the checklist rather than by reading the diff. On an over-long selection the
toolbar opened and Listen/Translate/Explain were correctly inert — and looked exactly like the
working buttons. `colors.text` → `colors.textSecondary` on the icon is indistinguishable in the
light theme, and the labels were already `textSecondary`.

Functionally right, and still the wrong outcome: press Listen, nothing happens, back to "it doesn't
work" — the impression this whole change exists to remove. Now dimmed by opacity with a line above
the row saying why (`shots/q15.png`).

---

## Found while here, not fixed

**A WebView error fires on every reader load.** `window.onerror: Uncaught TypeError: Cannot read
properties of null (reading 'addEventListener')`, thrown from the injected script on `about:blank`.
Present on an unmodified checkout, so it predates this work. Every `X.addEventListener` on a
nullable target lives in `readerHtml.ts`; the reader appears to work, so something is being wired up
that silently is not. Worth its own pass.

---

## Acceptance — the six steps

Run on the owner's own Android phone, 2026-09-02, on Play build 24. All six pass.

1. Select a sentence → **no sound at all** before pressing anything.
2. Press Listen → brief spinner → **the whole sentence** is read, to the end.
3. Press Listen again while it reads → stops.
4. Long-press a word → card opens, **no sound**; the card's speaker reads the word.
5. With a word playing, select a sentence and press Listen → reads the **sentence**.
   This is the one that was broken; it must not be silent.
6. Select a paragraph longer than ~500 characters → the toolbar appears, Copy and Highlight work,
   Listen/Translate/Explain are visibly unavailable. Previously nothing appeared at all.

## Emulator results

All six passed on the Pixel 7 Pro. Evidence, in order:

| step | evidence |
|---|---|
| 1 | sentence arrives as `mode:'drag'` 1.48 s after the word; `tts_played` count unchanged |
| 2 | `tts_played kind:'sentence'`; AudioTrack delivered **98496 frames @ 24 kHz = 4.10 s**, and the server returns exactly 4.10 s for that text — read to the end, nothing cut |
| 3 | second press returns the button to "Listen"; no full-length stop logged |
| 4 | long-press logs `selected word: motorcar` with no `tts_played`; the toolbar's speaker then logs `kind:'word'`, 43776 frames = 1.82 s |
| 5 | word starts at `12:36:11.644` (1.82 s long); Listen on the sentence pressed at `12:36:12.319` — 0.675 s in, still playing — logs `kind:'sentence'`. Under the old code this press was a stop. |
| 6 | 569-character selection opens the toolbar (previously nothing at all); Listen logs no `tts_played`, Translate opens no sheet |

Highlight could not be exercised — the pass ran as a guest, and the highlight button is gated on
`isAuthenticated`.

## Device pass — 2026-09-02

The owner ran all six steps on their own phone against Play build `versionCode 24` and reported
them passing. That is the first time this work has been exercised on real hardware rather than on
a Pixel 7 Pro emulator, and it closes the question the report was opened to answer.

Two things it deliberately does not claim:

- **It was not the reporter's Galaxy S24.** The symptom was reported on One UI, and One UI is a
  different input stack. The decisive defect turned on a suppression window with roughly 30 ms of
  margin, which is why the bug looked device-specific in the first place. The fix removes the race
  rather than widening the margin, so it should hold anywhere — "should" being the operative word
  until the phone that showed the bug says otherwise.
- **It was an informal pass, not a logged one.** The emulator run above has per-step evidence:
  frame counts, timestamps, log lines. This one is a person saying it looked right, which is worth
  more for step 5 and less for anything a log could have settled.

Remaining: the reporter confirming on the S24. Everything else this report asked for is done.

## Closed — 2026-09-03

The reporter ran the six steps on the Galaxy S24 that produced the original bug. That was the one
device this report could not settle for itself: the decisive defect turned on a suppression window
with roughly 30 ms of margin, One UI is a different input stack, and every earlier run was a Pixel 7
Pro emulator or a second Android phone.

Nothing here is open.
