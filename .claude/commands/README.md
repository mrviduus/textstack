# Slash commands

These are the project slash commands for the TextStack repo. Each command is a markdown file with a frontmatter block that declares its scope and tools. Claude Code finds them by itself: type `/<name>` in the prompt.

## Commands

| Command | Purpose | When to use |
|---------|---------|-------------|
| `/check` | Run the tests and builds that `git diff` makes relevant. Give a short pass/fail summary. | Before `/pr`. After any non-trivial change. |
| `/pr` | Make the PR title, body and area label, push, and open the PR with `gh`. The PR is the changelog. | At the end of a slice, after `/check` is green. |
| `/changelog` | Where a change is written down; the Play "What's new" text. | A wrong title or label, an incident, an ADR, a Play build. |
| `/changelog-week` | Pick last week's reader-visible PRs with the owner; write their `## Public` blocks. | Mondays. |

## Workflow: the usual path

`/slice` was removed on 2026-08-20. It read a `PLAYBOOK-ai-portfolio.md` that never
existed in git, and the AI-portfolio phases it was written for are complete. Give
Claude the brief (an issue or a doc) directly instead.

```
1. read the slice brief (issue or doc)

2. work on the slice with Claude Code as usual

3. /check
   → detects which apps changed via git diff
   → runs only relevant suites in parallel
   → reports green or fixes-needed

4. /pr
   → builds PR title (= the changelog line) + area label
   → builds PR body (= the write-up) from template + slice brief
   → pushes and opens PR via gh

```

## Workflow: outside slices

```
- Hotfix: a PR like any other (a push straight to main never reaches the changelog).
- Dependency bump: Dependabot's PRs carry `dependencies` and stay off the changelog.
```

## Why commands and not full subagents

One developer works on one slice at a time. Subagents would add configuration work for little benefit. Slash commands give 80% of the value (a standard workflow, fewer manual steps) at 10% of the complexity.

If the team grows or parallel epics start, look at this again. Then add `architect` / `developer` / `tester` subagents in `.claude/agents/`.

## Editing these commands

- The file name (without `.md`) is the command name.
- The frontmatter `description` shows in `/help`.
- The frontmatter `argument-hint` shows after the command name in autocomplete.
- The frontmatter `allowed-tools` limits what Claude can use during the command. Keep the list narrow.
- `$ARGUMENTS` in the body is replaced by the text the owner types after `/<command>`.

After an edit, the next `/<command>` run uses the change. No reload is necessary.

## Conventions assumed

- The changelog is the merged PRs (titles + area labels), shown by week on `/changelog`; `CHANGELOG.md` is frozen.
- The `gh` CLI is authenticated.
