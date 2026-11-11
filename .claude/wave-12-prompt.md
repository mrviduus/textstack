# V2 wave 12 — size R8, finish the PDF gate, pre-M5 gaps

Repo `/Users/vasylvdovychenko/projects/textstack/refactor/textstack`, branch `main`. Wave 11 closed
2026-11-11, prod `/health/ready` 200, `v2: off`: #1194 (#1174 deleted-upload tombstone), #1197 (#1187
restore by fraction), #1199 (#1186 outbox failure counts), #1202 (#1182 fork pin bump, KF8/AZW3 reads),
#1205 (#1128 PDF on the dev hosts). #1200 (Dependabot compose images) merged, #1201 closed (ignore that major). #1182 closed.
#1013: R7 **not** ticked; #1128: the PDF checkbox **not** ticked. Same pipeline as waves 3–11
(`.claude/wave-7-prompt.md`: brief → implement → /check → QA mutations → /code-review high, xhigh for
data writes → fix → /pr).

**Merge right: ask ONCE at the start of the wave**, not per PR (the owner found per-PR asks excessive in
wave 11). The answer covers that wave only. Merge = auto-merge + ALL CI jobs green; never `--admin`.

## Where wave 11 ended

- **Fork pin** `mrviduus/foliate-js@b3386ef9` (`textstack-pin`): the old pin + 6 commits (typed KF8
  blobs, KF8 sections through `transformTarget`, relocate reason forwarded, PDF null outline, PDF fetches
  nothing at import, paginator `setStyles` guard). Not adopted: `89e837c`, `5f4de61`. Every further fork
  push and pin change needs the owner's explicit yes.
- **KF8/AZW3 reads**, on a synthetic fixture only (Calibre-generated from redistributable text; source,
  tool version and hash in the README). It does not establish compatibility with real Kindle books.
- **A transitional position restores by fraction** (#1187): `textstack-*` state with a `bookFraction`
  opens near the place, approximate (words vs bytes); opening a book writes nothing until the reader
  moves. Annotations with `textstack-anchor-v1` stay undrawn → #1195. Pre-paginated EPUB saves no
  position → #1196.
- **Deleted uploads are remembered on the device** (#1174): id set `offline:deletedOnServer`; the shared
  `v2Book` answers a retryable 503, not a false 404, when a store reset drops the pull. Residue: #1191
  (orphan sweep trusts an empty V2 list), #1192 (sign-out leaves both id sets), #1193 (hidden book's
  bytes / reader deep link).
- **Outbox counts failures** (#1186): `outbox.failures`, 5 per session then skipped, never parked,
  never dropped; reset each session; stuck entries shown with "Try again" on the dev screen. Residue:
  #1198.
- **PDF on the V2 page:** dev hosts only (#1205). pdf.js from the pinned fork on the page's
  own thread (no Worker, CSP unchanged), lazy chunks `pdf` + `pdfcmaps`, polyfill prelude for old
  WebViews, `pdf-page {"page":N}` positions through store and sync. The open lifecycle changed for
  every format: build before teardown, `openSeq` (latest attempt) vs `viewSeq` (view on screen), save
  flushed + old book destroyed at the swap, a kept book answers `opened`, `restored` carries the book
  key, hosts share `openTracker.mjs`. **Gate: desktop Chromium half only** — 55 real uploads, all
  open/page/resume, 1 blank first page, 1 scan without text. No device row. The ADR-012 viewer stays.
  Gaps: #1203 (fork: links with Named actions, page release, non-idempotent `render()`, loading task,
  serial outline, bytes held 2–3×), #1204 (hostile PDF freezes the page; JPEG 2000). No highlights on
  PDF yet. Two books are alive during every build (not measured on a device).

## Wave 12 candidates (owner picks)

| Work | Issue | Notes |
|---|---|---|
| **R8 parity audit** — list what the legacy readers do that the V2 page does not; sizes every remaining wave | #1040 | read-only; do this first. Estimate today: 5–7 waves to M6 |
| PDF gate, device half: WebView/emulator rows, real-device memory, old-WebView behaviour | #1128 | needs the owner's corpus again (the local copy was deleted) or the emulator with fixtures only |
| PDF fork fixes: link service no-ops, page release, idempotent `render()`, loading-task destroy, outline off the open path | #1203 | fork push + pin bump = owner's yes |
| PDF highlights / translation / word tap parity | #1128 | after the gate |
| R7 — PDF on the V2 path end to end (`pdf-page` through sync on both hosts) | #1039 | the page half is in; hosts + server round trip left |
| `textstack-anchor-v1` annotations as quotations | #1195 | needs a list UI; may wait for R8 |
| Takedown restore gap | #1138 | deferred in wave 11; pre-M5; prod has 0 takedowns |
| Wave-11 residue | #1191–#1193, #1196, #1198 | small, mobile |
| CBZ position rule, wipe policy | #1188, #1070 | owner's rule calls first |

## Still owed by the owner

**New in wave 11:**
- Two ADR-032 sentences, unanswered: (1) KF8 is accepted on synthetic evidence only; (2) the PDF gate
  applies from the PR that ships the PDF module. No ADR was edited.
- Device checks, none done, none marked passed: the checklists in #1194, #1197, #1199, #1202, #1205.
- Whether `Mobile OTA (auto)` should keep shipping mobile changes nobody ran on a device (every wave-11
  merge went out over OTA untested on hardware; the V2 paths are dev-route / flag-off).
- PDF decisions: JPEG 2000 images (needs pdf.js wasm → a CSP change; accepted as a gap for now); pdf.js
  on the UI thread vs a Worker (a Worker needs `worker-src` in the CSP; today a hostile PDF can freeze
  the page); real-world KF8 samples.
- A real DRM-free AZW3 if one exists.

**Carried:** make the `mobile` CI job a required check; #1188 CBZ rule; #1070 wipe policy; the R6/R4
device matrix and the #1152/#1153 true-hardware rows; dump-archive location outside restic retention;
cutover date; the WebView ≥ 117 screen; Apple verification review before M5; `make migrate-v2` on prod;
the 2 Failed uploads' fate at cutover; Dependabot alerts; Play Console items; a CI dev-server pass for
`@v2-reader-dev`; the local `/auth/test-login` 500.

## Wave 11 lessons (add to waves 3–10's)

- **"Park after N failures" was the wrong first design**: one server outage would have parked every
  entry. Ask "what does a whole-service outage do to this counter?" before any retry cap.
- **Build before teardown, compare against the view on screen.** The open lifecycle went through three
  rounds; what held: one counter that only goes up decides whether a build may swap in, a second names
  the view on screen, and every listener/queued call is stamped with the second.
- **An experiment branch first, then a landing branch** worked for the fork eval and the PDF gate: the
  report (what was measured, on what) existed before any code was proposed for `main`.
- **Private corpus rules held and should be reused:** copy outside the repo, mode 700, index-only output
  (no names, ids, text, screenshots, network), delete after the last run.
- **A background "deploy watch" reports the previous run when the merge triggers no deploy** (mobile-only
  paths → OTA only). Match the run's head SHA to the merge commit before reporting.
- The harness classifier refuses a merge on a vague yes and refuses saving a standing merge delegation
  to memory. Do not retry or work around; ask for the explicit sentence once.
- xhigh review found real bugs after two QA rounds on the PDF slice, mostly in the vendored adapter the
  PR first shipped. When a PR turns on third-party code, review that code too, not only the diff.
