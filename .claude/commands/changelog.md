---
description: Where a change gets written down, now that PRs are the changelog. Fixes a release-notes line, routes incidents, ADRs and STATUS.
argument-hint: (no args) or '<PR number>' whose release-notes line to fix
allowed-tools: Bash, Read, Edit, Write
---

# /changelog — the PR is the changelog

Since #1220 nobody writes changelog lines. Each deploy creates a dated GitHub release (`2026.11.12`,
`.2` for a second deploy that day) whose notes list the PRs merged since the previous release, by
title, in sections picked by area label (`.github/release.yml`). `CHANGELOG.md` and
`docs/changelog-archive/` are frozen: never add to them.

## Where things go

| What happened | Where it goes |
|---|---|
| Any merged change | The PR: title = the release-notes line, one area label, description = the write-up |
| It broke production | Postmortem in `docs/incidents/` (copy `_TEMPLATE.md`), plus a row in its README |
| It changed a load-bearing decision | ADR in `docs/01-architecture/adr/` |
| It finished, or created, open work | `docs/STATUS.md`, and one GitHub issue per open item |

## Fixing a line

- **Not deployed yet:** fix the PR itself — `gh pr edit <n> --title "..."`,
  `gh pr edit <n> --add-label <area> --remove-label <wrong>`. The next release picks it up.
- **Already released:** `gh release edit <tag> --notes-file <file>` after
  `gh release view <tag> --json body --jq .body > <file>` and editing that file.

## A change with no PR

A hotfix pushed straight to `main` has no PR, so the next release does not list it. Do not push
straight to `main`; if it happened, add a line to that release by hand (`gh release edit`, above).
