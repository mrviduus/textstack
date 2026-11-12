# 2026-10-12 — QA-007 reader on Android with the reader engine (emulator)

Pixel 7 Pro emulator, **debug** dev client, JS from Metro on branch `reader-engine/phase3-mobile-b`
(PR #816) with `EXPO_PUBLIC_READER_ENGINE=true`. Production API, the account signed in on the emulator.
Books: *The Aeneid* (reflow), *The Rustonomicon* (reflow, downloaded), `qa-reader-test` (uploaded PDF,
downloaded). Run by an agent: real input over adb, the WebView over CDP. Engine page confirmed on every
reflow check (`#ts-root` present). The baseline is the [2026-10-08 run](2026-10-08-reader-android.md) on the old page.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Kill and reopen mid-chapter | ✅ | Aeneid II: y 10148 → 10111, the next line (PR A: 4–8 px) |
| 2 | Next → Prev | ✅ | Book III, then back to Book II at the place (the chapter end, where Next was tapped), highlight repainted |
| 3 | PDF reopens on page 7 | ✅ | bottom of page 7 → bottom of page 7 (~60 px). Old PDF viewer: the flag is reflow only |
| 4 | Font size / line height | ✅ (PR A) | not re-run: `__textstackApplyTypography` unchanged since PR A (26 px and back kept the line) |
| 5 | Airplane mode, downloaded book | ✅ | Rustonomicon ch. 2 opened offline, same paragraph. y 2188 → 1913 is not drift: 2188 was in the chapter-end block, progress caps at 100%, the reader returns to the text's end |
| 6 | Big font, kill, reopen | ✅ (PR A) | not re-run, see #4 |
| 7 | Chapter-1 highlight absent in chapter 2 | ✅ | Book II highlight; Book III paints none |
| 8 | Highlight next to a vocab word, inline on | ✅ | "did the goddess doubtfully" across the glossed "goddess": the highlight covers exactly those words, the gloss untouched |
| 9 | MCP highlight paints | — | needs the owner (Claude MCP on the account) |
| 10 | Vocab underline + inline translations | ✅ | 4 "goddess" underlined with "богиня" above; `setShowInlineTranslations(false)` hides labels (jsdom test) |
| 11 | Select → Back | ✅ | WordCard closes, reader stays, the mark and the page selection are gone |
| 12 | Phone → web | — (indirect) | not run (no web login for the emulator's account). The engine writes the same TextPosition v1 (mapper fixtures), and PR A reopened an engine-saved place on the same line in the old page |
| 13 | Renderer crash | ✅ | CDP `Page.crash`: the page reloads (a marker set before the crash is gone), engine page, same place |
| 14 | Slow network | ✅ | `gsm` speed + `gprs` delay, kill, open: at the place at 6 s and still at 26 s |

**PR B features, same run:** a hold posts `wordEngage` then one `selection` (mode `tap`) and the WordCard
opens with the translation; dragging a native handle extends it to a phrase (`drag`) and the highlight
toolbar opens; Highlight paints it; a tap on it posts one `highlightTap` and opens the editor; a colour
change repaints it; scroll-to-highlight centres it (top 435 of 868); an image tap opens the lightbox, a
backdrop tap closes it.

**Findings:**
- The native selection handles stay after a hold (#798). Kept: they are how a hold grows into a phrase.
- Dev build only: the Expo dev-menu button sits over the lightbox's ×, and a LogBox toast swallows taps.
- Test artefact, not a bug: inserting an image into a chapter text node through CDP made the engine
  throw `IndexSizeError` (its text nodes changed under it; the engine never changes them itself).
