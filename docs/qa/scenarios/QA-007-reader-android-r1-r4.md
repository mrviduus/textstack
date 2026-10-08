# QA-007: Reader R1–R4 on a real Android phone

**Area**: Mobile reader (reflow + Original PDF)
**Priority**: High — the reader is the main component; every R1–R4 mobile fix (#713–#731) is
unit-tested only, and the reader engine (ADR-025, planned) will be measured against this list
**Platform**: Android phone, the build carrying #723/#728/#730/#731 (check the OTA in About)
**Last Tested**: never
**Status**: Not run

---

## Why this scenario exists

Mobile e2e does not run in CI, and jsdom has no layout. So nothing automated has ever seen these fixes
on a screen. It is also the baseline for the reader engine: Phase 3 reruns this exact list with the
engine flag on.

Setup: sign in with the QA account. Have one EPUB book with 3+ long chapters, one uploaded PDF, and a
few saved vocabulary words. Write the result in the last column: ✅ / ❌ + a note.

## Checks

| # | Steps | Expected | Result |
|---|---|---|---|
| 1 | Open a chapter, scroll to the middle, wait 3 s, swipe the app away (kill), reopen the book | Same paragraph on screen | |
| 2 | In the middle of chapter 1, tap Next, read a bit, tap Previous | Back in chapter 1 at the same paragraph | |
| 3 | PDF: go to page 7, wait 3 s, kill the app, reopen | Page 7, not page 6/8 or 1 | |
| 4 | Middle of a chapter: Settings → font size +2, then line height + | Same sentence stays near the top third | |
| 5 | Download a book, turn on airplane mode, open it | Opens at once at your place, no spinner wait | |
| 6 | Custom typography (big font) set, kill the app, reopen the book | Opens at your place, not at the top | |
| 7 | Highlight a sentence in chapter 1, go to chapter 2 | The highlight is NOT painted in chapter 2 | |
| 8 | Highlight words next to a saved vocab word with inline translations on | Highlight covers exactly the selected words | |
| 9 | Ask Claude (MCP) to save a highlight in this book, then reopen the chapter | The MCP highlight is painted | |
| 10 | Vocab words in the chapter | Underlined; inline translations show/hide with the setting | |
| 11 | Select text → toolbar opens → press Back | Toolbar closes, the reader stays open | |
| 12 | Read on the phone, then open the same chapter on web | Web lands on the same paragraph | |
| 13 | Leave the reader in the background ~10 min with other heavy apps open, return | Reader reloads at the same place (WebView crash recovery) | |
| 14 | Slow network (Developer options → or a weak signal): open a book | Opens from the device; position not reset to 0 | |

## Report

Save the run in `docs/qa/reports/YYYY-MM-DD-reader-android.md`. Any ❌ goes to `docs/STATUS.md`
under the reader row before anything else is built on top.
