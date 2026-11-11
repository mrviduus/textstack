# Slash commands

Project-level slash commands for the TextStack repo. Each command is a markdown file with a frontmatter block declaring its scope and tools. Claude Code picks them up automatically — type `/<name>` in the prompt.

## Commands

| Command | Purpose | When to use |
|---------|---------|-------------|
| `/check` | Run all relevant tests/builds based on `git diff`. Concise pass/fail summary. | Before `/pr`. After any non-trivial change. |
| `/pr` | Build PR title + body + area label, push, open PR via `gh`. The PR is the changelog. | End of slice, after `/check` is green. |
| `/changelog` | Where a change is written down; how a milestone release is cut. | A wrong title/label, an incident, an ADR, a Play build. |

## Workflow — happy path

`/slice` was removed on 2026-08-20 — it read a `PLAYBOOK-ai-portfolio.md` that never
existed in git, and the AI-portfolio phases it was written for are complete. Point
Claude at the brief (issue or doc) directly instead.

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

## Workflow — outside slices

```
- Hotfix: a PR like any other (a push straight to main never reaches the changelog).
- Dependency bump: Dependabot's PRs carry `dependencies` and stay off the changelog.
```

## Why these commands and not full subagents

Solo dev workflow. Sequential slice work. Subagents would add configuration overhead without proportional benefit. Slash commands give 80% of the value (workflow standardization, reduced friction) at 10% of the complexity.

If/when the team grows or parallel epics start: revisit and add `architect` / `developer` / `tester` subagents in `.claude/agents/`.

## Editing these commands

- File name (without `.md`) becomes the command name.
- Frontmatter `description` shows in `/help`.
- Frontmatter `argument-hint` shows after the command name in autocomplete.
- Frontmatter `allowed-tools` limits what Claude can use during this command — keep narrow.
- `$ARGUMENTS` in the body substitutes the user's input after `/<command>`.

After editing, the next `/<command>` invocation picks up changes — no reload needed.

## Conventions assumed

- The changelog is the merged PRs (titles + area labels), shown by week on `/changelog`; `CHANGELOG.md` is frozen.
- `gh` CLI authenticated.
