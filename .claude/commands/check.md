---
description: Run all relevant tests, lints, and builds for the current changes. Smart-detects scope from git diff.
argument-hint: (no args) or 'full' to force full suite
allowed-tools: Bash, Read, Grep
---

# /check — pre-PR verification

Find what changed and run only the relevant gates. The gates are the same as in CI, but they run locally and take less time.

## Step 1 — Detect scope

```bash
git diff --name-only origin/main...HEAD 2>/dev/null || git diff --name-only HEAD~1
```

Sort the changed files:

- `apps/web/**` → web tests + build
- `apps/admin/**` → admin build
- `apps/mobile/**` → mobile tsc + e2e
- `backend/src/**` → dotnet test + build
- `tests/**` → run that test project only
- `infra/**` or `docker-compose*.yml` → flag for a manual smoke test (no automatic test)
- `docs/**` only → skip everything, report "docs-only, no checks needed"

If `$ARGUMENTS` is `full`, run everything. Ignore the detection.

## Step 2 — Run gates in parallel where safe

The gates are independent. Run them in parallel: one message, a separate Bash tool call for each.

```bash
# Backend (only if backend touched)
dotnet build textstack.sln --nologo -v quiet
dotnet test --nologo -v quiet --filter "FullyQualifiedName!~SlowTests"

# Web (only if web touched)
pnpm -C apps/web typecheck 2>&1 || pnpm -C apps/web exec tsc --noEmit
pnpm -C apps/web test --run
pnpm -C apps/web build

# Admin (only if admin touched)
pnpm -C apps/admin build

# Mobile (only if mobile touched)
cd apps/mobile && npx tsc --noEmit
```

Set `timeout: 300000` (5 min) on each Bash call. If a command needs more than 5 min, run it without a timeout and let it stream.

## Step 3 — Optional E2E

E2E is slow. Run it only in one of these cases:
- The owner passed `full`.
- The changes touch `apps/web/src/pages/**` or `apps/web/e2e/**`.

```bash
pnpm -C apps/web test:e2e --reporter=line
```

For mobile E2E, the trigger is a change in `apps/mobile/app/**`.

## Step 4 — Concise summary

Report in this exact format:

```
✅ Backend     dotnet build + test (N tests, Ys)
✅ Web         tsc + vitest + build (M tests, Zs)
⏸️  Admin       not touched, skipped
✅ Mobile      tsc clean
⚠️  E2E         3 of 47 failed — see below

[failed details if any]
[any warnings worth surfacing]

Result: 1 of 5 gates failed. Fix before /pr.
```

If all gates are green: `Result: all gates green. Ready for /pr.`

## Step 5 — On failure

For each failing gate:
1. Show the relevant failing line from the output.
2. Give the most likely cause (for example a missing import, a snapshot mismatch, or test data).
3. Do NOT fix it yourself. Wait for the owner to decide.

The owner runs `/check` to know if the change is ready to ship. The owner does not want you to start a long debugging session.
