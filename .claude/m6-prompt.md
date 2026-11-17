# V2 M6 — retire legacy

Repo `/Users/vasylvdovychenko/projects/textstack/refactor/textstack`, branch `main`. M5 done 2026-11-17: prod
`Database:Mode=v2`, `Features:V2Api=true`, legacy DB read-only + archived (tag `pre-v2-cutover`; log
`internal/ops/v2-cutover-2026-11-17.md`). Plan: `docs/internal/v2/v2-plan.md` §5.5. Status: `docs/STATUS.md`, #1013.

## Order (one PR each; ask "start" before building)
1. **Phone first.** New Android store build (the Play build predates #1228: no V2 reader on the phone) + owner
   device check of the V2 reader (open EPUB/PDF at its place, highlight, word, offline).
2. **Old-client log window** (#1330): `Gone in V2` / `X-App-Version` lines; the window ends by the log, not a date.
3. **Deletions**, after 1–2:
   - catalog/SEO/SSG backend + crews + ssg-worker + SSG scripts + nginx/deploy steps + `TextStack.Search`
   - `AppDbContext` + EF packages + `SchemaDriftTests`
   - legacy `database/migrations/` (git history keeps them; `database/v2/` becomes `database/`)
   - web/admin/mobile catalog UI
   - legacy reader (R8; `packages/reader-engine` + old reader screens)
   - `DROP DATABASE` last, only after the archive dump is restored and verified.
4. Close: every `/changelog` road step `done`, STATUS.md, #1013 M6 ticked; then the CLAUDE.md V2-status rule and
   the `/changelog` road block go.

## Standing rules
- Never touch production. English only in the repo; nothing about security in public text.
- Review budget: max 2 rounds per slice; round 2 correctness only; polish → one follow-up issue.
- Auto-merge only after the final fix commit is confirmed (CI green on all jobs, the mobile job included).
- Stacks: merge with merge commits, bottom-up; after a retarget, push `main` into the stacked PR so CI runs.
- Tests = few domain stories. A deletion deletes its tests; no new test to prove something is gone.
- Hide or retire over port. No new tables.
- Wave close: STATUS.md, `/changelog` road (`MOVE_STEPS`, `MOVE_UPDATED`, `MOVE_OPEN`), #1013.
