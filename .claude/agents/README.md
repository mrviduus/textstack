# TextStack — Claude Code roles & workflow

Project-local Claude Code config. **All senior.** Each agent is a focused persona with its own
system prompt + tool access (`.claude/agents/*.md`). Files live under `.claude/` which is gitignored
(personal config) — to share with a team, commit selected files (not `settings.local.json`).

## The roles

| Agent | When to use | Owns |
|-------|-------------|------|
| **architect** | Before any non-trivial feature — design first | Layering, data model, ADRs, trade-offs, the plan |
| **backend-engineer** | Server-side work | API/Application/Domain/Infra, EF migrations, `TextStack.Ai.*`, Worker |
| **frontend-engineer** | Web/admin UI | React, hooks, SSE clients, i18n, `packages/` |
| **mobile-engineer** | Mobile app | Expo Router, WebView reader, EAS, Android launch |
| **reader-engine** | Reader engine work, test-first (ADR-025) | `packages/reader-engine`: render, position, decorations, selection |
| **qa-automation** | Verify before ship — adversarially | xUnit/Vitest/Playwright, eval suites, blind spots, CI |
| **tech-writer** | After a feature lands | CHANGELOG, ADRs, architecture docs, `CLAUDE.md` |
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
   tech-writer   → CHANGELOG + ADR for what shipped
```

You stay the conductor: approve the plan, answer the open questions, decide what merges.
**Solo-dev shorthand:** for most slices, architect → engineer → qa is enough; pull in PM for a new
phase/feature, tech-writer when the decision is worth recording.

## Slash commands (`.claude/commands/`)

- `/pr` — open a PR (waits for CI by head-SHA, never merges red).
- `/check` — pre-merge gate (build + tests + format).
- `/changelog` — draft the CHANGELOG entry.

Commands are mechanical recipes; agents are personas. Use a command inside an agent's run when it fits.

## Skills (`.claude/skills/` — not set up)

Optional. Add a skill when a multi-step procedure recurs verbatim (e.g. "add a new ITool",
"add an EF entity + migration + writer", "run a prod eval"). Until then the agents' system prompts
encode the conventions. Ask to scaffold one when a pattern keeps repeating.

## Conventions every role inherits (see `CLAUDE.md`)

Clean Architecture · central package versions (`Directory.Packages.props`) · snake_case EF ·
small PRs + CHANGELOG · **deploy only via GitHub Actions** (never manual SSH) · every LLM call through
the `ILlmService` gateway · eval gates split into deterministic (CI) + judged/live (prod).
