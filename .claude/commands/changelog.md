---
description: Where a change gets written down, now that PRs are the changelog. Routes incidents, ADRs and STATUS; drafts Play "What's new".
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
- **No GitHub releases** for the app. Android users read Play's "What's new" (below).

## Where things go

| What happened | Where it goes |
|---|---|
| Any merged change | The PR: title, one area label, description = the write-up |
| Reader-visible change | Nothing now; `/changelog-week` proposes it for the page |
| It broke production | Postmortem in `docs/incidents/` (copy `_TEMPLATE.md`), plus a row in its README |
| It changed a load-bearing decision | ADR in `docs/01-architecture/adr/` |
| It finished, or created, open work | `docs/STATUS.md`, and one GitHub issue per open item |

## Play Store "What's new"

When the owner promotes an Android build to Play production (`mobile-release.yml`), draft its
"What's new" text: the Android-tagged `public` entries merged since the previous production build,
plain words, at most 500 characters. The owner pastes it into Play Console. Nothing goes to GitHub
Releases (`2026.11.11` there only marks the switch; the page counts from it).

## Fixing a line

The title or label of a merged PR is still editable: `gh pr edit <n> --title "..."`,
`gh pr edit <n> --add-label <area> --remove-label <wrong>`. The page shows it from the next deploy.
A push straight to `main` has no PR and appears nowhere; do not do it.
