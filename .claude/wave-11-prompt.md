# V2 wave 11 — reader track closes out (R7, PDF gate) + pre-M5 gaps

Repo `/Users/vasylvdovychenko/projects/textstack/refactor/textstack`, branch `main`. Wave 10 closed
2026-11-10, 8 PRs merged + deployed, prod `/health/ready` 200, `v2: off`: #1173 (#1168 stale relocate),
#1178 (#1163/#1164 mobile error states), #1179 (#1121 shared V2 client factories), #1180 (#1078 sync
prereqs), #1181 + #1183 (#1128 format work, backend + page), #1184 (CI fix), #1185 (**R6 #1038 — local
library + sync client**). #1013: R6 ticked; #1128 has only the PDF gate left. Same pipeline as waves
3–10 (`.claude/wave-7-prompt.md`: brief → implement → /check → QA mutations → /code-review high, xhigh
for data writes → fix → /simplify → /pr). **Merge right stays per-PR** (wave-10 pattern: ask before
each merge; check ALL CI jobs, not just required — see lessons).

## Where wave 10 ended

- **R6 is in:** SQLite `textstack-v2` (books/state/annotations, serial queue), outbox sync to `/me/v2`
  per the PDD (per-page pull transactions WITH cursor, per-entry push isolation, parked terminal
  refusals in a `blocked` column, `whileCurrent` at every await), opt-in file sync over the shared
  `uploadV2File` (known-ids, never imports a twin), legacy JSON migration with UUID re-keying.
  1111 mobile + 710 shared tests. Deferrals: #1186 (backoff/unpark), #1187 (textstack-* positions not
  restorable by the V2 page — decide before M5), #1188 (CBZ position server rule — owner), #1189
  (local remove / metadata PATCH), #1070 (wipe policy, 2 new notes).
- **Formats are in:** the page reads MOBI6 (+combo-as-MOBI6), FB2/FBZ (UTF-16 re-encoded; custom-entity
  FB2 refused — a 90 KB flat expansion hung the page), CBZ (textless, page-name positions). Per-format
  readers are escaped strings run under the page's own nonce — CSP unchanged; QA held it against 28
  breakout vectors. KF8/AZW3 is REFUSED: broken at fork pin `d73682a4` (#1182 — typeless resource
  blobs + sections bypass transformTarget). Refusals run before teardown: a bad pick leaves the open
  book reading.
- **One V2 client:** `packages/shared/src/api/{v2Books,v2Upload}.ts`; mobile adopted web's epoch rules,
  web adopted mobile's clock clamp. R6 builds on it.

## Wave 11 candidates (owner picks)

| Work | Issue | Notes |
|---|---|---|
| #1128 PDF gate: foliate PDF on the real uploads, delete the pdf.js viewer on pass | #1128 | needs the real PDF uploads + likely a fork pin bump (#1182 ride-along) |
| Fork pin bump carrying the KF8 fixes (+ evaluate `89e837ce`) | #1182 | fork commit is the owner's push; then re-run D6 gates |
| textstack-* / bookFraction restore in the V2 page | #1187 | pre-M5; small page change (foliate has fraction nav) |
| Deleted-upload tombstone on device | #1174 | one mechanism: Library cache, reconnect rehydrate, partial removal |
| Outbox backoff + unpark surface | #1186 | resilience polish |
| Takedown restore gap | #1138 | schema or API change; prod has 0 takedowns |
| R6/R4 device matrix (owner's phone) | #1038/#1036 | the full list is in #1185's archive entry |

## Still owed by the owner

**New:** make the `mobile` CI job a required check (branch protection — auto-merge landed it red twice
in wave 10); the #1188 CBZ position rule; the #1182 fork commits (Claude can write them, the push to
`mrviduus/foliate-js` and the pin-bump yes are yours); the R6 device matrix; #1070 wipe policy.
**Carried:** dump-archive location outside restic retention (before the production ETL); cutover date;
the WebView ≥ 117 screen; the true-hardware device rows (#1152/#1153 + R4); Apple verification review
before M5; `make migrate-v2` on prod; the 2 Failed uploads' fate at cutover; Dependabot (3: 1 high,
2 moderate); Play Console items; a CI dev-server pass for `@v2-reader-dev`; the local
`/auth/test-login` 500 (breaks repo e2e globalSetup locally).

## Wave 10 lessons (add to waves 3–9's)

- **Auto-merge + "green CI" is only as green as the REQUIRED checks.** The `mobile` job isn't required;
  two PRs merged with it red (a test's literal dynamic import of the gitignored `.vendor/` clone — tsc
  type-resolves literal `import()` paths). Check `gh pr checks` for ALL jobs before arming auto-merge.
- The altitude pass caught a "better fix" that broke a failure path: bumping the open seq at `openUrl`
  silently un-saved the still-open book after a failed file read. When hardening a lifecycle, state
  the invariant ("a refusal leaves the current book usable") and test the refusal paths explicitly.
- QA's `it.fails` repro tests are a cheap contract between rounds: the fix round flips them to `it`
  and nothing about the bug is re-litigated.
- Per-slice agents + the three rounds scaled to 8 merged PRs in a day; the tax is squash-merge
  changelog/archive conflicts on every dependent branch — update and re-arm them serially, newest
  last, and expect GitHub's CONFLICTING flag to lag a push by ~a minute.
- An over-cap guard must match the server's UNIT (SyncValidation counts UTF-16 units, not code
  points), and "refuse, don't cut" when an exact-compare consumer (restore) reads the value back.
