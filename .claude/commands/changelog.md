---
description: Where a change gets written down, now that PRs are the changelog. Routes incidents, ADRs and STATUS; drafts Play "What's new".
argument-hint: (no args)
allowed-tools: Bash, Read, Edit, Write
---

# /changelog — the PR is the changelog

Since #1220 nobody writes changelog lines. `CHANGELOG.md` is frozen: never add to it.

- **The record** is the merged PRs: title = one scannable line, one area label (its section),
  description = the full write-up.
- **Readers** see the `/changelog` page in the web app: merged PRs grouped by week. Its reader view
  shows the PRs labelled `public` (`## Public` block). `/changelog-week` adds those labels and blocks
  once a week, not per PR.
- **No GitHub releases** for the app. Android readers read Play's "What's new" (see the section "Play Store What's new").

## Where things go

| What happened | Where it goes |
|---|---|
| Any merged change | The PR: title, one area label, description = the write-up |
| Reader-visible change | Nothing now; `/changelog-week` proposes it for the page |
| It broke production | Postmortem in `docs/internal/incidents/` (copy `_TEMPLATE.md`), plus a row in its README |
| It changed a load-bearing decision | ADR in `docs/architecture/adr/` |
| It finished, or created, open work | `docs/STATUS.md`, and one GitHub issue per open item |

## Play Store "What's new"

The owner promotes an Android build to Play production (`mobile-release.yml`). Then draft its
"What's new" text from the Android-tagged `public` entries merged since the previous production build.
Use plain words and 500 characters at most. The owner pastes the text into Play Console. Nothing goes
to GitHub Releases (`2026.11.11` there only marks the switch; the page counts from it).

## Fixing a line

You can still edit the title or label of a merged PR: `gh pr edit <n> --title "..."`,
`gh pr edit <n> --add-label <area> --remove-label <wrong>`. The page shows the change from the next deploy.
A push straight to `main` has no PR and shows nowhere. Do not push straight to `main`.
