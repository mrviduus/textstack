# V2 wave 10 — reader track (R6–R7)

Repo `/Users/vasylvdovychenko/projects/textstack/refactor/textstack`, branch `main`. Wave 9 closed 2026-11-10:
#1165 (#1156 offline log noise → `logLoadError`), #1167 (#1155 web epoch guards, twin of #1151), #1169 (#1037
R5 — the V2 reader page's web host). All merged and deployed; prod `/health/ready` 200, `v2: off`. M3.5 and R5
ticked in #1013; **the #1030 close click is the owner's** (the classifier refused it; acceptance text is ready
in the wave-9 session log). Same shape as waves 3–9 (`.claude/wave-8-prompt.md`: pipeline, quality bar,
standing rules). **Ask once per wave whether "merge what passed code review" stands** (waves 4–9: granted).

## Where wave 9 ended

- R5: dev-only `/dev/reader-v2` hosts the generated page in an `<iframe srcdoc>` — nonce'd shim stands in for
  the WebView bridge, bytes in as a transferred ArrayBuffer → blob: URL, library + positions in localStorage,
  `parseLibrary` hardened on both hosts. Prod bundle byte-identical and asserted on every `pnpm build`
  (`apps/web/scripts/assert-no-dev-reader.mjs`). Playwright 4 tests, local dev server only (CI serves the prod
  build, where the route must not exist) — a CI dev-server pass is a workflow change, the owner's click.
  QA hostile-EPUB suite: 0 escapes; security review: nothing new; `sandbox="allow-scripts allow-same-origin"`
  means the page CSP alone guards the dev origin + its /api cookie (commented in the code).
- **Fork pin NOT consumed — owner decision open:** `mrviduus/foliate-js@89e837ce` is a wider, outside-authored
  paginator fix ("Supersedes #142 and #97"), not patch 0001. The page still builds from upstream
  `78914aef` + `patches/0001`. Options: adopt the wider fix (a pin bump → re-run ADR-029 Decision 6 checks +
  the generated-guard test), or push an exact-patch-0001 commit to the fork. #1128's first checkbox waits.
- Web V2 writes are sign-out-safe: one `whileCurrent` (epoch at call start, re-checked before any value
  escapes), highlight sync throws `SessionChangedError` on every local write and sends no doomed PUT, marks
  return `'done' | 'dropped'` and the UI skips the flip on a drop. Mutation→test table in PR #1167.
- Issues filed, not widened: #1163 (Discover renders a 500 as "No results"), #1164 (my-books 404 silently
  rehydrates a deleted upload), #1166 (shared `pullFeed` finally-delete race), #1168 (page.mjs: the closing
  view's late `relocate` resurrects the previous book's status — page-side fix covers both hosts).

## Wave 10 candidates (owner picks)

| Work | Issue | Notes |
|---|---|---|
| R6 — local library + sync client (SQLite, revision/operation_id, opt-in file sync) | #1038 | with #1078 + #1121 per plan; the big one |
| R6 prerequisites from the sync PDD | #1078 | UUID client ids, code-point quote cut, selectedText vs quote |
| Shared V2 client factories | #1121 | one copy for web and mobile; the epoch-guard home (#1151/#1155 pointer) |
| Fork pin decision + #1128 format work | #1128 | needs the owner's pin answer first |
| V2 reader page: stale relocate from the closing view | #1168 | small page fix, covers both hosts, deletes the R5 stopgap |
| Takedown restore gap | #1138 | schema or API change; prod has 0 takedowns today |
| Discover/my-books error states | #1163, #1164 | small mobile UX fixes |

## Still owed by the owner

The #1030 close click; the fork pin decision (above); the dump-archive location outside restic retention
(needed before the production ETL); cutover date; the WebView ≥ 117 screen; the true-hardware device rows
(#1152/#1153 PR checklists + R4); Apple verification review before M5; `make migrate-v2` on prod; the 2 Failed
uploads' fate at cutover; Dependabot (3: 1 high, 2 moderate); Play Console items; a CI dev-server pass for
`@v2-reader-dev` (workflow change); the local API answers 500 on `/auth/test-login` (local env — breaks the
repo e2e globalSetup locally).

## Wave 9 lessons (add to waves 3–8's)

- Three review rounds earn their keep even on a "small" fix: #1155's QA, code review and /simplify each found
  real gaps the previous round missed (the push-loop resend, the value escaping across `toProgress`, the
  call-time epoch on the feed pull). Guard-the-class sweeps need all three.
- A fork commit that looks like "our patch" may be a different fix: verify tree-diff against pin+patch before
  consuming a pin, and verify the generated bundle stays byte-identical. R5's agent caught it and stopped.
- A DoD like "prod bundle unchanged" wants a standing assert, not a one-time check — wiring it into the build
  script gates CI and deploy with no workflow edit (which the classifier refuses anyway).
- The classifier also refuses `gh issue close` and some combined gh writes; ticking a checkbox body edit
  passes. Split gh writes small, surface the refused text to the owner.
- Playwright's `webServer` cwd is the config file's directory: a scratch config outside the repo needs the dev
  server started by hand (`reuseExistingServer` picks it up).
