# 2026-10-08 — QA-007 reader on Android (emulator)

Pixel 7 Pro emulator, **release** build of `f14b4630` (debug for #13 and the scroll check), production
API as a **guest**, *1984* + one uploaded 15-page PDF. Run by an agent; #9 and #12 need a signed-in
account and are left to the owner.

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Kill and reopen mid-chapter | ✅ | same paragraph, ~1 line off |
| 2 | Next → Prev | ✅ | identical screen |
| 3 | PDF reopens on page 7 | ⚠️ | page 7 at the top edge → page 7. Page 7 filling ~90% with a sliver of page 6 above → reopens at the **top of page 6** |
| 4 | Font 18→22, line height 1.8 | ✅ | same sentence at the top |
| 5 | Airplane mode, downloaded book | ✅ | opened < 1.5 s at the place, highlights painted |
| 6 | Big font, kill, reopen | ✅ | same screen |
| 7 | Chapter-1 highlight absent in chapter 2 | ✅ | chapter 2 paints only its own |
| 8 | Highlight next to a vocab word, inline on | ✅ | rect text = the selected words |
| 9 | MCP highlight paints | owner | needs an account |
| 10 | Vocab underline + inline toggle | ✅ | label hides, underline stays |
| 11 | Select → Back | ✅ | toolbar closes, reader stays |
| 12 | Phone → web | owner | needs one account on both |
| 13 | Renderer crash | ✅ | CDP `Page.crash` → `restoreAnchor` 0.3 s later, same screen (debug). `am kill` on release cold-starts on Discover; reopening the book lands at the place |
| 14 | Slow network | ✅ | `gsm`/`gprs` throttle: opened in 2 s at the place, still there at 12 s |

**Scroll fix (#777), on device:** old `scrollToInstant` left scrollY at the start target in 20/20
runs of `10573,10573,0` / `5000,0` / `3000,0,7000,0` (a smooth animation instead of a jump); the fixed
one landed within 0 px every time, and 20/20 real `__textstackRestoreScroll` calls landed exactly.

**Other findings (logged in STATUS, not started):** PDF reopen one page back (#3); guest's online
Library empty after a download without "Save to Library"; Books list genre chips stretch tall and
searching "1984" shows "No books found"; Library "Continue" opens book detail, not the reader; native
selection handles stay after highlighting; "pocketed → enterrado" (pt-BR) is a wrong translation; PDF
detail says "~33 pages" for a 15-page PDF.
