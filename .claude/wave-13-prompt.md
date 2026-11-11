# V2 wave 13 — R8 wave A: production hosting for the V2 reader

Repo `/Users/vasylvdovychenko/projects/textstack/refactor/textstack`, branch `main`. Wave 12 closed
2026-11-11, prod `/api/health/ready` ready, `v2: off`. Merged: #1207 (#1191 store reset never deletes
downloads), #1208 (R8 parity audit), #1209 (R7 `pdf-page` tests), #1210 (flaky spend-alert test), #1211
(CI: Playwright deps best-effort, one web build per `e2e` run). Open for the owner at close: #1212
(#1192), #1213 (legacy TOC number + mobile TTS language). #1013: R7 **not** ticked. Same pipeline as
waves 3–12 (`.claude/wave-7-prompt.md`: brief → implement → /check → QA mutations → /code-review high,
xhigh for data writes → fix → /pr).

**Merging: the owner reviews and merges every PR** (decided mid-wave 12: "create PR, I will review").
Open the PR, give the link, stop. No `gh pr merge --auto`, for code or docs. Do not ask for the merge
right at the start of the wave.

## Read first

`docs/01-architecture/r8-parity-audit.md` — the gap matrix, the proposed R8 DoD (§5), the recommended
answers (§6, the owner said "ok, do it" to the list on 2026-11-11: name the one you build on in the
brief), the waves (§7).

## Wave 13 candidates (owner picks)

| Work | Issue | Notes |
|---|---|---|
| **Wave A** — Android native https serving (no `file://`, ADR-029 D4), web prod route behind `Features:V2Api`, web host on the shared V2 sync client, loading/error states, `ready`/`opened` deadlines | #1040, #1080, #1081 | no issue per item yet: open them first. The WebView ≥ 117 screen is the owner's call and blocks the Android half |
| Orphan sweep keeps a server-deleted book's bytes (mark only) + a "remove" action for hidden books | #1191 (question), #1193 | recommended 2026-11-11; do both together |
| Wave-11 residue left | #1196, #1198 | #1196 waits for the #1188 rule (recommended: page by entry name) |
| PDF gate, device half | #1128 | skipped in wave 12; needs the owner's corpus or emulator fixtures |
| PDF fork fixes | #1203 | fork push + pin bump = owner's yes |
| Takedown restore gap | #1138 | pre-M5; prod has 0 takedowns |

## Still owed by the owner

**New in wave 12:** review of #1212 and #1213; a plain yes/no on each recommended answer in the audit §6
before code depends on it; device checklists in #1207 and #1212.

**Carried:** everything in wave 12's list (`.claude/wave-12-prompt.md` "Still owed by the owner").

## Wave 12 lessons (add to waves 3–11's)

- **Subagents inherit the session model's limit.** Three audit agents died at once on the model limit;
  after the owner switched models a resume message continued each from its transcript. Resume, never respawn.
- **A deploy re-runs CI on the merged tree**, so a flaky test fails the deploy after a green PR. Read the
  deploy run's jobs, not only the PR's checks. And `https://textstack.app/health/ready` answers the SPA's
  HTML with 200: the API's is `/api/health/ready`.
- **Before calling a concurrent test flaky, read the code under it** for a real lost-update. It took five
  minutes and made the "widen the wait" fix an honest one.
- **`gh pr checks --watch` right after a push returns "no checks"**; wait for the run to register first.
- **A red required check from a runner outage is not ours to retry forever.** Three retries, then stop
  and say so; the durable fix was to stop depending on apt (#1211). A `continue-on-error` step still
  spends its full retry time: cap it with `timeout-minutes`.
- **Two PRs that both add a CHANGELOG line conflict**; the second needs `main` merged in.
- **Worktrees pile up: 44 of them, 82 GB.** At wave close remove every worktree whose PR is merged and
  whose tree is clean, and its local branch. Never force-remove one with uncommitted files (the harness
  refuses, rightly); list those for the owner.
