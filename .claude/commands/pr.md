---
description: Create a PR with title, description, rollback plan, a one-line CHANGELOG entry and its archive write-up. Detects slice number from branch/commits.
argument-hint: (no args) or '<slice-number>' to override detection
allowed-tools: Bash, Read, Edit, Grep, Glob
---

# /pr — create PR + update changelog

End-of-slice ritual: commit any pending changes, build PR description, append changelog entry, push, open PR.

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

**Detect slice number:** look at commit messages for `my-books-v2 [NN]:` pattern. If `$ARGUMENTS` provided, use that. If neither — ask user.

**Detect the Area** for the changelog line (one of: `Reader`, `Library`, `Vocabulary`, `Book Chat`, `Mobile`, `Users`, `Admin`, `SEO`, `Observability`, `Ops`, `Worker`, `AI quality`, `Infra`, `Docs`) by looking at most-touched paths.

## Step 2 — Read slice brief (if applicable)

If the user names a slice brief (an issue or a doc), read it to extract:
- Slice title
- Goal (one sentence)
- Rollback plan
- Feature flag name (if any)

This makes the PR description self-documenting.

## Step 3 — Build PR title

Format: `my-books-v2 [<NN>]: <slice-title>`

Examples (from existing commits):
- `my-books-v2 [01]: persistent header upload button`
- `my-books-v2 slice 02: drag-drop anywhere on web`

Keep under 72 chars. If non-slice work, use plain conventional style: `fix(library): ...` or `feat(reader): ...`.

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

## Step 5 — Write the changelog + archive entry

**This is the part you must NEVER skip.**

The changelog is split across three files on purpose (see the header of `CHANGELOG.md`). Where a
change is written depends on what it is — read this before typing anything:

| What happened | Where it goes |
|---|---|
| Any merged change | **One line** in `CHANGELOG.md` |
| That change needs more than one line | Full write-up in `docs/changelog-archive/<YYYY>-H<1\|2>.md` |
| It broke production | Postmortem in `docs/incidents/`, from `_TEMPLATE.md` |
| It changed a load-bearing decision | ADR in `docs/01-architecture/adr/` |
| It finished or created open work | Update `docs/STATUS.md` in the same PR |

### 5a — The line in `CHANGELOG.md`

Under `## [Unreleased]`. **One line, hard limit.** No paragraph, no sub-bullets, no bold-headed
"Root cause." blocks — those are exactly what pushed this file to 1800 lines and 379 KB, and they now
live in the archive.

```markdown
- **<Area>** — <what changed, one clause> — <scope> · [details](docs/changelog-archive/2026-H2.md#<anchor>)
```

`<Area>`: Reader, Library, Vocabulary, Book Chat, Mobile, Users, Admin, SEO, Observability, Ops,
Worker, AI quality, Infra, Docs. `<scope>`: `backend`, `web`, `mobile`, `infra`, or a combination.

Add `· [**postmortem**](docs/incidents/<file>.md)` **before** the details link when one exists.

If the change genuinely needs no write-up (a dependency bump, a typo), omit the details link entirely.
Do not create an empty archive section to have something to point at.

### 5b — The archive entry

Append at the **top** of the current half-year file, `docs/changelog-archive/<YYYY>-H<1|2>.md`:

```markdown
<a id="<anchor>"></a>

## <same text as the changelog line, without the links> — YYYY-MM-DD

<the full write-up: what, why, what was ruled out, what it cost>
```

`<anchor>` = `YYYY-MM-DD-` + the heading lowercased, non-alphanumerics collapsed to `-`, truncated to
60 chars. Must match the link in `CHANGELOG.md` exactly — check it.

This is where the article material goes. Write it as well as you would have written it in the old
changelog; the only thing that changed is which file it lands in.

**Date** in ISO format via `date +%Y-%m-%d`.

### 5c — Release heading

`## [Unreleased]` becomes `## [YYYY.MM.DD]` (CalVer, the deploy date) when the PR merges — deploy is
automatic on merge to `main`. If a release section for today already exists, append to it and leave
`[Unreleased]` empty with `_Nothing yet._`.

## Step 6 — Commit changelog

If you edited CHANGELOG.md as part of this command (and it wasn't already committed):

```bash
git add CHANGELOG.md docs/changelog-archive docs/incidents docs/STATUS.md
git commit -m "changelog: my-books-v2 [<NN>] <slice-title>"
```

This commit goes on top of the slice's other commits. Reviewer sees the changelog update as a separate commit — easy to verify.

## Step 7 — Push and create PR

```bash
git push -u origin $(git branch --show-current)

gh pr create \
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

## Step 8 — Output to user

Report:

```
PR opened: <url>
Title: <title>
Changelog: one line under ## [Unreleased] + write-up in docs/changelog-archive/<YYYY>-H<N>.md

Next steps:
- Request review (or self-review the diff one more time).
```

## Failure modes — handle gracefully

- `gh` not authenticated → tell user to run `gh auth login`, do NOT auto-handle.
- Push rejected (non-fast-forward) → STOP. Show user the conflict, do not force-push.
- CHANGELOG.md / archive edit conflict (file changed between read and edit) → re-read and retry once. If still conflicts → ask user.
