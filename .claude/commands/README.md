# Slash commands

Project-level slash commands for the TextStack repo. Each command is a markdown file with a frontmatter block declaring its scope and tools. Claude Code picks them up automatically — type `/<name>` in the prompt.

## Commands

| Command | Purpose | When to use |
|---------|---------|-------------|
| `/check` | Run all relevant tests/builds based on `git diff`. Concise pass/fail summary. | Before `/pr`. After any non-trivial change. |
| `/pr` | Build PR title + body, append changelog entry, push, open PR via `gh`. | End of slice, after `/check` is green. |
| `/changelog <category>: <text>` | Manually append a changelog entry. | Hotfix / dep bump / anything outside `/pr` flow. |

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
   → builds PR title from slice number
   → builds PR body from template + slice brief
   → appends bullet to CHANGELOG.md under ## [Unreleased]
   → commits CHANGELOG.md change
   → pushes and opens PR via gh

```

## Workflow — outside slices

```
- Hotfix to main:
    git commit -am "fix: ..."
    /changelog Reader: fix highlight pulse for list view
    git push

- Dependency bump:
    pnpm -C apps/web update foo
    git commit -am "deps: bump foo"
    /changelog Infra: bump foo to vX.Y
```

## Why these commands and not full subagents

Solo dev workflow. Sequential slice work. Subagents would add configuration overhead without proportional benefit. Slash commands give 80% of the value (workflow standardization, reduced friction, no-forget changelog) at 10% of the complexity.

If/when the team grows or parallel epics start: revisit and add `architect` / `developer` / `tester` subagents in `.claude/agents/`.

## Editing these commands

- File name (without `.md`) becomes the command name.
- Frontmatter `description` shows in `/help`.
- Frontmatter `argument-hint` shows after the command name in autocomplete.
- Frontmatter `allowed-tools` limits what Claude can use during this command — keep narrow.
- `$ARGUMENTS` in the body substitutes the user's input after `/<command>`.

After editing, the next `/<command>` invocation picks up changes — no reload needed.

## Conventions assumed

- CHANGELOG.md at repo root, format: `## [Unreleased]` → `### <Category> (YYYY-MM-DD)` → bullets.
- Branch name pattern `ux/my-books-v2*` (or other epic branch).
- Commit message pattern `my-books-v2 [NN]: <title>` for slice work.
- `gh` CLI authenticated.
