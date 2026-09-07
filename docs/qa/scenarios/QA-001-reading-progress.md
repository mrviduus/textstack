# QA-001: Reading Progress, Navigation, and Auto-Save

**Area**: Reader, Library, Progress Sync
**Priority**: High
**Last Tested**: 2026-01-20 (steps 1-4) · steps 5-9 walked 2026-09-07 on Pixel_7_Pro (API 37)
against a local stack with the ADR-015 migration
**Status**: Steps 5, 6, 9 PASS. Steps 7-8 (offline, cross-device) still unrun. One unreproduced
miss recorded below.

---

## Preconditions

- [ ] User is logged in
- [ ] Personal library is empty (all books removed)
- [ ] No existing reading progress for test book (clear localStorage `reading.progress.*`)

## Steps

### 1. Start Reading a Book

1. Open the main page (`/`)
2. Select the first available book
3. Start reading the book
4. **Read until progress reaches >1%** (scroll/paginate enough)

**Verify**:
- [ ] Book is automatically added to **My Library** after **>1% progress** (not immediately)
- [ ] Book appears in library list with correct % shown

> **Note**: Auto-add triggers at >1% actual progress, not when book is first opened.

### 2. Read Through the Book

1. Continue reading until reaching a significant point (e.g., 20%+)
2. Progress should advance naturally as pages are read

**Verify**:
- [ ] Progress bar updates as reading progresses
- [ ] Progress percentage increases (check via localStorage or library)

### 3. Navigate via TOC (Direct Navigation)

1. Note current chapter and scroll position
2. Open TOC (table of contents) or book detail page
3. Select a **different chapter** (e.g., chapter 6)

**Verify**:
- [ ] Reader opens **directly at selected chapter start** (NOT at saved position)
- [ ] Chapter title updates correctly
- [ ] This behavior uses `?direct=1` param internally

> **Critical**: TOC/chapter links must go directly to chapter, not restore saved progress.

### 4. Exit and Resume via Library

1. Scroll partway into the new chapter (to save new position)
2. Navigate away (e.g., go to main page)
3. Open **My Library**
4. Click the same book from library

**Verify**:
- [ ] Reader opens at the **exact position where reading stopped** (not chapter start)
- [ ] Progress bar shows correct **overall book progress** (not chapter %)
- [ ] Navigation is responsive (no ignored clicks)

> **Critical**: Library links must restore saved progress (no `?direct=1`).

---

### 5. Read across a chapter boundary, then change a reader setting

> **This is the scenario every reported "it forgot where I was" has been.** The mobile reader
> appends the next chapter into the SAME document as you scroll — the URL never changes — so the
> chapter you are in and the chapter the app thinks you are in are two different questions. Steps
> 1-4 above never cross a boundary, which is why they passed for eight months while readers lost
> their place. See [ADR-015](../../01-architecture/adr/ADR-015-reader-position-is-logical.md).

1. Open chapter 1 of a multi-chapter book
2. Scroll down until chapter 2 appends and continue to roughly the middle of it
3. Note the sentence under the top quarter of the screen
4. Open reader settings and increase the font size twice

**Verify**:
- [ ] The **same sentence** is still under the top quarter of the screen
- [ ] No reload flash; the page does not jump to the top
- [ ] The top bar still names **chapter 2**
- [ ] Scrolling down continues into chapter 3 (the appended chapters were not thrown away)
- [ ] Highlights and saved-word underlines are still drawn, and in the right places

> **Result 2026-09-07** — walked on Alice's Adventures in Wonderland, scrolled from chapter 1 into
> chapter 7 by infinite scroll, then 18px→22px, 1.65→1.8, centre→justify. The same sentence stayed
> under the reading line; the top bar still read "Pig and Pepper"; the footer still read 7/13, 51%;
> the appended chapters were not lost. The server row afterwards was
> `scroll:7-pig-and-pepper:16389`, percent 0.5068, `chapter_id` resolving to `7-pig-and-pepper` —
> the row agreeing with itself — and `position_json` holding an anchor quoting the text at the
> reading line.
>
> The first attempt of this step, before the fix was completed, drifted about two paragraphs: the
> reflow was re-anchored by chapter FRACTION, and justify plus a line-height change re-wraps
> unevenly. It re-anchors by text now.

### 6. …then kill the app and come back

1. From the state above, force-stop the app (swipe away is not enough on Android)
2. Reopen and tap Continue Reading

**Verify**:
- [ ] Opens **chapter 2**, at the same sentence — not chapter 1, at any position

> **Result 2026-09-07** — Continue Reading opened chapter 7 and restored to the anchored sentence
> (`[diag] restoreAnchor: anchor 13455`), on a warm re-entry and on a cold start.
>
> **Open, unreproduced:** the FIRST cold entry after a fresh install landed at the top of chapter 7
> instead of the saved position. Two later cold starts restored correctly and it has not recurred.
> Crucially the saved position was **not overwritten** — the write gate held, and the row still read
> 51% afterwards — so this is "did not restore", not the data loss this work is about. The
> `[diag] restoreAnchor:` line added in that session distinguishes the three ways it can fail
> (no chapter registered, no resolver, anchor unresolved); reproduce with `adb logcat`/Metro
> attached and read it rather than guessing.

### 7. The same, offline

1. Airplane mode ON before opening the book
2. Repeat steps 5 and 6

**Verify**:
- [ ] Same result. The position is written locally whether or not the server can be reached

### 8. Cross-device, and the old build

1. Read to a known sentence mid-chapter on the phone; wait 3s
2. Open the same book on web

**Verify**:
- [ ] Lands within a sentence of the same place — not at the top of the chapter, and not at the
      equivalent *pixel*, which is a different place on a different screen

3. Install the previous APK alongside (or roll the OTA back) and read on it

**Verify**:
- [ ] The old build still resumes — it reads the `locator`, which is still written
- [ ] After it writes, `position_json` on that row is **NULL** rather than left contradicting the
      pixel offset (`reference_prod_db_access` for the query)

### 9. PDF in Original layout is untouched

1. Open an uploaded PDF that opens in Original layout
2. Change the font size (or confirm the control is hidden), read a few pages, leave, return

**Verify**:
- [ ] Resumes on the same **page**; the stored locator is still `page:<N>` and `position_json` NULL

---

## Expected Results

| Check | Expected |
|-------|----------|
| Auto-add to library | After >1% progress |
| TOC navigation | Goes directly to selected chapter |
| Library resume | Restores exact saved position |
| Progress bar | Shows overall book % (not chapter %) |
| Auto-save | Position preserved in localStorage + server |
| Font change mid-chapter | Same sentence stays under the reading line |
| Font change after infinite scroll | Still in the chapter you were in, not the one in the URL |
| Cross-device resume | Within a sentence, not the same pixel |

---

## Key Behavior Distinction

| Action | Behavior |
|--------|----------|
| Click chapter from TOC/book page | Direct navigation (`?direct=1`) |
| Click book from Library | Restore saved progress |
| "Start Reading" button | Direct to chapter 1 |

---

## Actual Issues Observed

_Document any bugs found during testing:_

| Date | Issue | Status |
|------|-------|--------|
| — | — | — |

---

## Test History

| Date | Tester | Result | Notes |
|------|--------|--------|-------|
| 2026-01-20 | Claude | ✅ Pass | Full scenario test after multisite removal. Auto-add at 2%, TOC direct nav works, library resume works. |
| 2026-01-19 | Claude | ✅ Pass | All steps verified. TOC vs Library distinction working correctly. |
