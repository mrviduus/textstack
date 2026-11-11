---
description: Create a PR with title, area label, description and rollback plan. The PR is the changelog: title = the line, description = the write-up.
argument-hint: (no args) or '<issue-number>' to override detection
allowed-tools: Bash, Read, Edit, Grep, Glob
---

# /pr — create PR

End-of-slice ritual: commit any pending changes, build title + description, label, push, open PR.

**The PR is the changelog (#1220).** The `/changelog` page lists merged PRs by week, by title, in
sections picked by area label (`.github/release.yml`). Never edit `CHANGELOG.md` or
`docs/changelog-archive/`: both are frozen. Whether a PR is reader-visible (`public`) is decided
weekly by `/changelog-week`, not here.

## Pre-conditions

Before starting:
1. `/check` should be green. If not run yet, ask user to run it first. If user insists on skipping, proceed but warn in PR description.
2. Working tree should have all intended changes staged or committed.

## Step 1 — Detect context

```bash
BASE=$(git merge-base HEAD origin/main 2>/dev/null || echo "HEAD~5")
git log --oneline ${BASE}..HEAD                  # commits in this PR
git diff --stat ${BASE}..HEAD                    # change scope
git branch --show-current                        # branch name
git status --short                               # any uncommitted?
```

**Detect the issue** the PR closes (branch name, commits, or `$ARGUMENTS`). Every task has one; none found → ask.

**Pick one area label** by the most-touched paths: `reader`, `mobile`, `library`, `vocabulary`, `ai`
(incl. MCP), `data` (DB, V2 schema, ETL), `ops` (infra, CI, deploy), `documentation`. The list lives in
`.github/release.yml`; the `PR labels` check fails a PR without one.

**Reader-visible?** Not decided here: `/changelog-week` picks the week's `public` PRs with the owner.

## Step 2 — Read slice brief (if applicable)

If the user names a slice brief (an issue or a doc), read it to extract:
- Slice title
- Goal (one sentence)
- Rollback plan
- Feature flag name (if any)

This makes the PR description self-documenting.

## Step 3 — Build PR title

The title is the PR's line on the changelog page, read by someone scanning a week. Conventional style,
under 72 chars, saying what changed, issue number at the end:

- `feat(reader): V2 page reads AZW3 (KF8) (#1182)`
- `fix(mobile): sign-out clears the declined and deleted-on-server id sets (#1192)`

## Step 4 — Build PR body

Use this template (HEREDOC):

```markdown
## Summary

<1–2 sentences from slice Goal>

## Slice

<link to the slice brief or issue, if any>

## Changes

- <bullet per significant change, grouped by area>
- <e.g. "Added `<UploadButton />` to Header.tsx, auth-gated">
- <e.g. "New endpoint `POST /me/books/{id}/finished`">

## Tests

- Unit: <list of new/changed test files>
- Integration: <if any>
- E2E: <if any>

## Rollback plan

<one-liner from slice brief, or commit revert if no flag>

## Notes

<anything reviewer should know — gotchas, follow-ups, open questions>
```

## Step 5 — Route what is not the PR

The PR description is the full write-up (the old archive entry's job): what, why, what was ruled out,
what it cost. Write it that well. Only these go to files, in the same PR:

| What happened | Where it goes |
|---|---|
| It broke production | Postmortem in `docs/incidents/`, from `_TEMPLATE.md` |
| It changed a load-bearing decision | ADR in `docs/01-architecture/adr/` |
| It finished or created open work | `docs/STATUS.md`, and an issue per open item |

## Step 6 — Push and create PR

```bash
git push -u origin $(git branch --show-current)

gh pr create \
  --label <area> \
  --title "<title from step 3>" \
  --body "$(cat <<'EOF'
<body from step 4>
EOF
)"
```

If PR already exists for this branch (`gh pr view` returns one), update title/body instead of creating new:
```bash
gh pr edit --title "..." --body "..."
```

## Step 7 — Output to user

Report:

```
PR opened: <url>
Title: <title>
Label: <area>

Next steps:
- Request review (or self-review the diff one more time).
```

## Failure modes — handle gracefully

- `gh` not authenticated → tell user to run `gh auth login`, do NOT auto-handle.
- Push rejected (non-fast-forward) → STOP. Show user the conflict, do not force-push.
