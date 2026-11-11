---
description: Weekly changelog pass — pick last week's reader-visible PRs, write their `## Public` blocks with the owner, fix missing area labels.
argument-hint: (no args) or '<YYYY-MM-DD>' = Monday of the week to cover (default: last week)
allowed-tools: Bash, Read, AskUserQuestion
---

# /changelog-week — what readers see on /changelog

Once a week (Monday). The `/changelog` page shows every merged PR by week; its reader view shows
only PRs labelled `public` with a `## Public` block (#1216). This pass decides which those are.
Nothing here edits the repo: it writes PR labels and descriptions on GitHub, and the page picks them
up at the next deploy.

## 1. Collect the week

Week = Monday 00:00 UTC to the next Monday. Default: the last full week; `$ARGUMENTS` overrides.

```bash
gh pr list --state merged --limit 200 \
  --search "merged:<monday>..<sunday> -label:dependencies" \
  --json number,title,labels,body,url
```

## 2. Area labels

Every PR needs one of `reader mobile library vocabulary ai data ops documentation`
(`.github/release.yml`). For each PR without one, propose the label from its title/paths; apply after
the owner's yes in step 4.

## 3. Draft public entries

Reader-visible = something a person reading books on textstack.app or the Android app can see or
feel *today*. Not: CI, tests, docs, refactors, dev-only V2 routes (`Features:V2Api` is off in
production), admin-only tools. When unsure, check `docs/STATUS.md`.

For each candidate, draft (format = `parsePublic` in `scripts/changelog-data.mjs`):

```markdown
## Public
Title: <short plain title, no jargon>
<Web, Android> · <New | Fix | Improved | Changed>
<one or two plain sentences: what the reader can now do or no longer suffers>
```

Several PRs for one user-visible change: one entry, on the PR that finished it.

## 4. Owner picks

AskUserQuestion, multi-select, up to 4 candidates per question (each option: PR number + the drafted
title; description = the sentence). Missing area labels go in the same dialog. The owner may answer
"Other" with an edited text — use it verbatim.

## 5. Apply (one GitHub write per Bash call)

For each picked PR:

```bash
gh pr view <n> --json body --jq .body > /tmp/pr<n>.md    # use the scratchpad dir
# append the block (replace an existing "## Public" section instead of adding a second)
PR_BODY="$(cat <file>)" node scripts/changelog-data.mjs --check   # must print "Public block OK"
gh pr edit <n> --body-file <file>
gh pr edit <n> --add-label public
```

## 6. Report

One line per PR: made public / label added / skipped. Plus: "Shows on /changelog after the next
deploy". If a Play production build shipped this week, remind about its release (`/changelog`,
"Milestone releases").
