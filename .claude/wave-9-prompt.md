# V2 wave 9 — reader track (R5–R7)

Repo `/Users/vasylvdovychenko/projects/textstack/refactor/textstack`, branch `main`. Wave 8 closed 2026-11-09:
#1152 (#1140–#1143 mobile V2 defects), #1153 (#1139 anchors carry offsets), #1154 (#1150 ETL computes legacy
offsets), #1157 (#1094 pinned by tests), #1159 (#1151 epoch guards + shared vocab), #1160 (#1118 feed file
summary), #1158 (restore-drill ETL rehearsal mode). All merged and deployed; prod `/health/ready` 200,
`v2: off`. **M3.5 rehearsals #2 and #3 passed** on GitHub runners (latest + pinned `318e2aef` nightly; reports
on #1030) — owner acceptance owed. Same shape as waves 3–8 (`.claude/wave-8-prompt.md`: pipeline, quality bar,
standing rules). **Ask once per wave whether "merge what passed code review" stands** (waves 4–8: granted).

## Where wave 8 ended

- ETL is rehearsal-proven three times (isolated pair on the server + 2 CI restore-drill runs): dry → real →
  `validate-etl.sql` exit 0 → re-run 0 writes → validate again. The ETL now computes offsets for legacy
  offset-less anchors (V2's own cap/context rules restated in SQL, twin-tested) and the report names every
  anchor V2 would refuse on edit.
- Mobile + web V2 clients hardened: anchors always carry offsets (`v2Locators.ts` throws on missing offsets,
  one contract copy), edits echo the stored locator (never recompute), post-await store writes go through
  `whileCurrent` + epoch, shared vocabulary cache is epoch-keyed, SQLite writes serialize through one queue.
- V2 feed carries ingestion/chapterCount/wordCount (transitional, dies at M6.4); shelf stops probing per book;
  job status writes bump `books.updated_at` so the change feed sees ingestion flips.
- Emulator checklist all PASS; only true-hardware rows stay with the owner.

## Wave 9 candidates (owner picks)

| Work | Issue | Notes |
|---|---|---|
| R5 — foliate fork renders V2 EPUB in the app | #1037 | ADR-032; **owner: tests in Playwright**; biggest unknown |
| Reader track umbrella (R5–R7 sequencing) | #1128 | app-layer locator/format rules widen here |
| Shared client factories | #1121 | with R6 per plan |
| R6 prerequisites | #1078 | with #1121 |
| Web post-await writes ignore reset epoch | #1155 | web twin of #1151, same `whileCurrent` shape |
| Offline console.error noise | #1156 | low |
| Takedown restore gap | #1138 | schema or API change; prod has 0 takedowns today |

## Still owed by the owner

M3.5 acceptance (3 rehearsals passed — accept + pick the dump-archive location outside restic retention);
cutover date; #1117 decision (brief on the issue, recommend B: bookmarks wait for R5/R6); #1109 decision
(recommend leave until R5, close as "waits for R5"); the WebView ≥ 117 screen; the true-hardware device rows
(#1152/#1153 PR checklists + R4); Apple verification review before M5; `make migrate-v2` on prod; the 2 Failed
uploads' fate at cutover; Dependabot; Play Console items.

## Wave 8 lessons (add to waves 3–7's)

- The classifier refuses Claude auto-merging a CI workflow change even with merge right granted — leave that
  click to the owner and say so early; everything else can go auto-merge + green CI.
- Parallel branches inserting archive entries at the same spot conflict every time: merge `origin/main` into
  each surviving branch right after every merge, and chain the archive-marker assert with `&&` so a failed
  assert stops the push.
- A "new" issue may already be implemented (#1094 was done in M3.2): check the code before scoping — the
  branch became tests + runbook only.
- QA on one slice keeps finding the neighbor's bug (#1139's QA found #1150; #1151's review found #1155):
  file the twin immediately, don't widen the branch.
- CI restore-drill rehearsals are cheap and repeatable (whole chain ~9 min on a GitHub runner); prefer them
  over server-side rehearsals now that #1158 is in.
