---
description: Weekly changelog pass — pick last week's reader-visible PRs, write their `## Public` blocks with the owner, fix missing area labels.
argument-hint: (no args) or '<YYYY-MM-DD>' = Monday of the week to cover (default: last week)
allowed-tools: Bash, Read, AskUserQuestion
---

# /changelog-week — what readers see on /changelog

Run this once a week (Monday). The `/changelog` page shows every merged PR by week. Its reader view
shows only the PRs labelled `public` with a `## Public` block (#1216). This pass decides which PRs those are.
This pass does not edit the repo. It writes PR labels and descriptions on GitHub, and the page shows
them at the next deploy.

## 1. Collect the week

A week is Monday 00:00 UTC to the next Monday. The default is the last full week; `$ARGUMENTS` overrides it.

```bash
gh pr list --state merged --limit 200 \
  --search "merged:<monday>..<sunday> -label:dependencies" \
  --json number,title,labels,body,url
```

## 2. Area labels

Every PR needs one of `reading library highlights vocabulary assistant account data ops documentation`
(`.github/release.yml`). For each PR without one, propose the label from its title and paths.
Apply the label after the owner says yes in step 4.

## 3. Draft public entries

Reader-visible = something that a reader on textstack.app or the Android app can see or
feel *today*. Not: CI, tests, docs, refactors, dev-only routes (`/dev/*`), admin-only tools. If you are not sure, check `docs/STATUS.md`.

For each candidate, write a draft (format = `parsePublic` in `tools/checks/changelog-data.mjs`):

```markdown
## Public
Title: <short plain title, no jargon>
<Web, Android> · <New | Fix | Improved | Changed>
<one or two plain sentences: what the reader can now do or no longer suffers>
```

If several PRs make one reader-visible change, write one entry, on the PR that finished the change.

## 4. Owner picks

Use AskUserQuestion, multi-select, with up to 4 candidates per question. Each option is the PR number
and the drafted title; its description is the sentence. Put missing area labels in the same dialog.
The owner can answer "Other" with an edited text. Use that text exactly as written.

## 5. Apply (one GitHub write per Bash call)

For each picked PR:

```bash
gh pr view <n> --json body --jq .body > /tmp/pr<n>.md    # use the scratchpad dir
# append the block (replace an existing "## Public" section instead of adding a second)
PR_BODY="$(cat <file>)" node tools/checks/changelog-data.mjs --check   # must print "Public block OK"
gh pr edit <n> --body-file <file>
gh pr edit <n> --add-label public
```

## 6. Report

Write one line per PR: made public / label added / skipped. Then add: "Shows on /changelog after the next
deploy". If a Play production build is going out, draft its "What's new" (`/changelog`,
section "Play Store What's new").
