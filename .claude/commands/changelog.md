---
description: Where a change gets written down, now that PRs are the changelog. Routes incidents, ADRs and STATUS; how a milestone release is cut.
argument-hint: (no args)
allowed-tools: Bash, Read, Edit, Write
---

# /changelog — the PR is the changelog

Since #1220 nobody writes changelog lines. `CHANGELOG.md` and `docs/changelog-archive/` are frozen:
never add to them.

- **The record** is the merged PRs: title = one scannable line, one area label (its section),
  description = the full write-up.
- **Readers** see the `/changelog` page in the web app: merged PRs grouped by week, with a reader
  view built from PRs labelled `public` (`## Public` block). Those labels and blocks are added once a
  week by `/changelog-week`, not per PR.
- **GitHub Releases** are milestones only (below), never per deploy.

## Where things go

| What happened | Where it goes |
|---|---|
| Any merged change | The PR: title, one area label, description = the write-up |
| Reader-visible change | Nothing now; `/changelog-week` proposes it for the page |
| It broke production | Postmortem in `docs/incidents/` (copy `_TEMPLATE.md`), plus a row in its README |
| It changed a load-bearing decision | ADR in `docs/01-architecture/adr/` |
| It finished, or created, open work | `docs/STATUS.md`, and one GitHub issue per open item |

## Milestone releases

Rule (owner, 2026-11-11): a release only when an **Android build is promoted to Play production**.
Tag `android-<versionName>`. The owner decides; Claude drafts, the owner publishes:

```bash
gh release create android-<x.y.z> --draft --title "Android <x.y.z>" \
  --generate-notes --notes-start-tag <previous android-* tag, or 2026.11.11>
```

Prepend a short hand-written intro to the generated list; the same text goes into Play's "What's new".
Sections come from `.github/release.yml`. `2026.11.11` marks the switch from `CHANGELOG.md`.

## Fixing a line

The title or label of a merged PR is still editable: `gh pr edit <n> --title "..."`,
`gh pr edit <n> --add-label <area> --remove-label <wrong>`. The page shows it from the next deploy.
A push straight to `main` has no PR and appears nowhere; do not do it.
