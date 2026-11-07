# Docs site + contributor golden path — brief

Goal: make TextStack easy to understand for new contributors and self-hosters.
Docs site at textstack.dev, admin moves to textstack.dev/admin.

## Priority order

1. **Reorganize docs/ into a clear public structure** (zoom-in, general → detail):
   - Getting started (run locally, self-host with docker compose)
   - Architecture: C4 L1 → L2 → L3 → key flows → ADRs
     (main C4 is buried in docs/01-architecture/review-2026-10/01-map.md;
     also README.md high-level view, flows.md, textstack-map.html — merge into one path)
   - Guides by area: backend, web, mobile, AI/MCP
   - Reference: API, env vars, config
   - Changelog
   Internal material (marketing, business, SEO, phase plans, research, loose
   root files) moves out of the public path, into docs/internal/.
   **Show me the proposed tree before moving files.**

2. **Golden paths section** ("How to do common things, one opinionated way"):
   - Run locally → make first PR (the contributor onboarding path) — do this one first
   - Add an API endpoint
   - Add an entity + migration (human version of .claude skill add-entity)
   - Add an AI/MCP tool (human version of .claude skill add-tool)
   - Add a web page / reader feature
   Each path: when to use it, the steps, files touched, how to test, a checklist
   before the PR. Reuse the .claude skills as the source, so humans and Claude
   follow the same path. Keep them short.

3. **Docs site generator** (I lean to Starlight; Docusaurus if versioned v1/v2 docs needed).
   Layout inspiration: shopify.dev structure (top tabs, left nav, right
   "On this page", search, card grid on home). Own brand colors/fonts
   (TextStack fonts from #885). Do NOT copy Shopify assets or icons.

4. **Move admin to textstack.dev/admin**, docs at textstack.dev root.

5. **Later — decoration:** original pixel icons in docs/assets/pixel-icons/ (edit grids in gen.py).

6. **Later, after v2 is stable:** awesome-selfhosted submission. I write it by hand
   (their rules ban LLM-generated PRs). Requirements already met: AGPL-3.0,
   first release v0.1.0 on 2026-05-06.
