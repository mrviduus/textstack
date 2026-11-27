# TextStack — Claude Code roles & workflow

Project-local Claude Code config. **All senior.** Each agent is a focused persona with its own
system prompt + tool access (`.claude/agents/*.md`). Files live under `.claude/`; agents, commands and skills are tracked, `settings.local.json` is not.

## The roles

| Agent | When to use | Owns |
|-------|-------------|------|
| **architect** | Before any non-trivial feature — design first | Layering, data model, ADRs, trade-offs, the plan |
| **backend-engineer** | Server-side work | API/Application/Domain/Infra, SQL migrations + Dapper, `TextStack.Ai.*`, Worker |
| **frontend-engineer** | Web/admin UI | React, hooks, SSE clients, i18n, `packages/` |
| **mobile-engineer** | Mobile app | Expo Router, V2 reader host, EAS, Android |
| **qa-automation** | Verify before ship — adversarially | xUnit/Vitest/Playwright, eval suites, blind spots, CI |
| **tech-writer** | After a feature lands | PR write-ups, ADRs, architecture docs, `CLAUDE.md` |
| **product-manager** | When *what/why/for whom* is unclear | Scope, DoD, value framing, PR slicing, roadmap |

## How to invoke

- **By name:** "use the **backend-engineer** to add the endpoint", or `@backend-engineer …`.
- **Auto-delegation:** if you just describe the task, Claude routes to the agent whose `description` matches. Keep descriptions specific (they're the routing signal).
- **Parallel:** spin up several at once for independent work (e.g. backend + frontend for the same feature, or 3 qa passes).
- Each agent runs in its **own context** and returns a result summary — it doesn't see your chat, so give it enough brief.

## The intended loop (how they work together)

```
product-manager  → what & why, scope, DoD, PR slices
   architect     → how: plan, seams, data model, open questions   (you approve)
backend / frontend / mobile  → implement the slice
   qa-automation → adversarial verify + Bug Report (before merge)
   tech-writer   → PR write-up + ADR for what shipped
```

You stay the conductor: approve the plan, answer the open questions, decide what merges.
**Solo-dev shorthand:** for most slices, architect → engineer → qa is enough; pull in PM for a new
phase/feature, tech-writer when the decision is worth recording.

## Slash commands (`.claude/commands/`)

- `/pr` — open a PR (waits for CI by head-SHA, never merges red).
- `/check` — pre-merge gate (build + tests + format).
- `/changelog` — where a change is written down; Play "What's new" text.

Commands are mechanical recipes; agents are personas. Use a command inside an agent's run when it fits.

## Skills (`.claude/skills/`)

- `add-entity` — a new table: SQL migration + Dapper repository + Persistence test.

Add a skill when a multi-step procedure recurs verbatim.

## Conventions every role inherits (see `CLAUDE.md`)

Clean Architecture · central package versions (`Directory.Packages.props`) · snake_case SQL, Dapper, no EF ·
small PRs, one area label each · **deploy only via GitHub Actions** (never manual SSH) · every LLM call through
the `ILlmService` gateway · evals: deterministic in CI, live ones skip without a key.
