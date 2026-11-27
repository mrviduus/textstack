# TextStack — Claude Code roles & workflow

This is the project Claude Code config. **All agents are senior.** Each agent is a focused persona with its own
system prompt and tool access (`.claude/agents/*.md`). The files are under `.claude/`. Git tracks the agents, commands and skills, but not `settings.local.json`.

## The roles

| Agent | When to use | Owns |
|-------|-------------|------|
| **architect** | Before any non-trivial feature — design first | Layering, data model, ADRs, trade-offs, the plan |
| **backend-engineer** | Server-side work | API/Application/Domain/Infra, SQL migrations + Dapper, `TextStack.Ai.*`, Worker |
| **frontend-engineer** | Web/admin UI | React, hooks, SSE clients, i18n, `packages/` |
| **mobile-engineer** | Mobile app | Expo Router, V2 reading screen host, EAS, Android |
| **qa-automation** | Verify before ship — adversarially | xUnit/Vitest/Playwright, eval suites, blind spots, CI |
| **tech-writer** | After a feature lands | PR write-ups, ADRs, architecture docs, `CLAUDE.md` |
| **product-manager** | When *what/why/for whom* is unclear | Scope, DoD, value framing, PR slicing, roadmap |

## How to start an agent

- **By name:** "use the **backend-engineer** to add the endpoint", or `@backend-engineer …`.
- **Automatic delegation:** if you only describe the task, Claude sends it to the agent with the matching `description`. Keep descriptions specific: Claude routes by them.
- **Parallel:** start several agents at once for independent work. For example, backend + frontend for the same feature, or 3 qa passes.
- Each agent runs in its **own context** and returns a result summary. The agent does not see your chat, so give it a full brief.

## The intended loop (how they work together)

```
product-manager  → what & why, scope, DoD, PR slices
   architect     → how: plan, seams, data model, open questions   (you approve)
backend / frontend / mobile  → implement the slice
   qa-automation → adversarial verify + Bug Report (before merge)
   tech-writer   → PR write-up + ADR for what shipped
```

You control the loop: approve the plan, answer the open questions, and decide what merges.
**Short loop for one developer:** for most slices, architect → engineer → qa is enough. Add the PM for a new
phase or feature, and the tech-writer when the decision is worth a record.

## Slash commands (`.claude/commands/`)

- `/pr` — open a PR (waits for CI by head-SHA, never merges red).
- `/check` — pre-merge gate (build + tests + format).
- `/changelog` — where a change is written down; Play "What's new" text.

Commands are mechanical recipes; agents are personas. An agent can use a command during its run when the command fits.

## Skills (`.claude/skills/`)

- `add-entity` — a new table: SQL migration + Dapper repository + Persistence test.

Add a skill when the same multi-step procedure comes back word for word.

## Conventions every role inherits (see `CLAUDE.md`)

Clean Architecture · central package versions (`Directory.Packages.props`) · snake_case SQL, Dapper, no EF ·
small PRs, one area label each · **deploy only via GitHub Actions** (never manual SSH) · every LLM call through
the `ILlmService` gateway · evals: deterministic in CI, live ones skip without a key.
