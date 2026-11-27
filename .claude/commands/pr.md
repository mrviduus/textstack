---
description: Create a PR with title, area label, description and rollback plan. The PR is the changelog: title = the line, description = the write-up.
argument-hint: (no args) or '<issue-number>' to override detection
allowed-tools: Bash, Read, Edit, Grep, Glob
---

# /pr — create PR

Do this at the end of a slice: commit any pending changes, make the title and description, add the label, push, and open the PR.

**The PR is the changelog (#1220).** The `/changelog` page lists merged PRs by week and by title.
The area label picks the section (`.github/release.yml`). Never edit `CHANGELOG.md`: it is frozen.
`/changelog-week` decides once a week if a PR is reader-visible (`public`). This command does not.

## Pre-conditions

Before you start:
1. Run `/check` first. If nobody ran it yet, ask the owner to run it. If the owner skips it, write a warning in the PR description.
2. The working tree must have all intended changes staged or committed.

## Step 1 — Detect context

```bash
BASE=$(git merge-base HEAD origin/main 2>/dev/null || echo "HEAD~5")
git log --oneline ${BASE}..HEAD                  # commits in this PR
git diff --stat ${BASE}..HEAD                    # change scope
git branch --show-current                        # branch name
git status --short                               # any uncommitted?
```

**Find the issue** that the PR closes (branch name, commits, or `$ARGUMENTS`). Every task has one. If you find none, ask.

**Pick one area label** from the paths that the PR changes most: `reading`, `library`, `highlights`, `vocabulary`,
`assistant` (incl. MCP), `account`, `data` (DB, V2 schema, ETL), `ops` (infra, CI, deploy, app releases),
`documentation`. Android is not an area: label by what changed for the reader. The list is in
`.github/release.yml`. The `PR labels` check fails a PR without a label.

**Reader-visible?** This command does not decide. `/changelog-week` picks the week's `public` PRs with the owner.

## Step 2 — Read slice brief (if applicable)

If the owner names a slice brief (an issue or a doc), read it and take out:
- Slice title
- Goal (one sentence)
- Rollback plan
- Feature flag name (if any)

Then the PR description explains itself.

## Step 3 — Build PR title

The title is the PR's line on the changelog page. A person who scans a week reads it. Conventional style,
under 72 chars, saying what changed, issue number at the end:

- `feat(reader): V2 page reads AZW3 (KF8) (#1182)`
- `fix(mobile): sign-out clears the declined and deleted-on-server id sets (#1192)`

## Step 4 — Build PR body

Write the description to the rules in `docs/writing.md`. Use this template (HEREDOC):

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

Docs: <updated | not affected>

## Notes

<anything reviewer should know — gotchas, follow-ups, open questions>
```

**The `Docs:` line (#1237).** A PR can change a command, an environment variable, a route, a flag or a
setup step. Then the same PR edits the page that states it (`docs/start/`, `docs/reference/`, `CLAUDE.md`).
Then write `Docs: updated`. If nothing of that kind changed, write `Docs: not affected`.

## Step 5 — Route what is not the PR

The PR description is the full write-up (the job of the old archive entry): what, why, what was ruled out,
and what it cost. Write it well. Only these items go to files, in the same PR:

| What happened | Where it goes |
|---|---|
| It broke production | Postmortem in `docs/internal/incidents/`, from `_TEMPLATE.md` |
| It changed a load-bearing decision | ADR in `docs/architecture/adr/` |
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

If a PR already exists for this branch (`gh pr view` returns one), update its title and body. Do not create a new one:
```bash
gh pr edit --title "..." --body "..."
```

## Step 7 — Output to the owner

Report:

```
PR opened: <url>
Title: <title>
Label: <area>

Next steps:
- Request review (or self-review the diff one more time).
```

## Failure modes

- `gh` is not authenticated → tell the owner to run `gh auth login`. Do NOT handle it yourself.
- The push is rejected (non-fast-forward) → STOP. Show the conflict to the owner. Do not force-push.
