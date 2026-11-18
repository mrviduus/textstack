# Testing

Goal: **everything is automatically testable** (CI runs it), with fast feedback locally and strong confidence before deploy.

> Checked 2026-11-17. The original MVP strategy (catalog flows, SEO checks, aspirational layers) was removed at M6; git history keeps it. What runs in CI is in `.github/workflows/ci.yml`.

---

## Quick Reference

### Backend Tests
```bash
dotnet test                                    # All tests
dotnet test tests/TextStack.UnitTests          # Unit only
dotnet test tests/TextStack.IntegrationTests   # Integration — needs the API running on :8080 (LiveApiFixture; override API_URL)
dotnet test tests/TextStack.Persistence.Tests  # Dapper repositories on real Postgres (Testcontainers; needs Docker)
dotnet test --filter "Name~YourTestName"       # Single test
```

### Frontend Tests
```bash
pnpm -C apps/web test       # Run all tests
pnpm -C apps/web test:watch # Watch mode
```

---

## Backend vs Frontend Strategy

| Layer | Backend (.NET) | Frontend (React) |
|-------|----------------|------------------|
| Unit | xUnit v3 | Vitest |
| Integration | `LiveApiFixture` → HTTP against a running API (docker compose in CI); `Persistence.Tests` → repositories on Testcontainers Postgres | (not used yet) |
| E2E | Playwright ([guide](e2e-tests.md)) | Playwright ([guide](e2e-tests.md)) |

### Backend Testing

**What to test:**
- Domain logic (entities, value objects)
- Service methods (business logic)
- API endpoints (integration)
- Repositories (Dapper SQL, `Persistence.Tests`)

**Naming convention:**
```
{MethodName}_{Scenario}_{ExpectedResult}
Build_StillProducesFour_WithNoDistractorsAnywhere
```

**Test file location:**
```
tests/
  TextStack.UnitTests/           # Pure logic, no DB
  TextStack.IntegrationTests/    # API against a running server
  TextStack.Extraction.Tests/    # Book parsing
  TextStack.Persistence.Tests/   # Dapper repositories, Testcontainers Postgres
  TextStack.AiEvals/             # Eval runners on fake LLMs; live evals skip w/o OPENAI_API_KEY
  TextStack.Ai.Mcp.Tests/        # MCP over-the-wire (loopback)
```

Integration runs trip production rate limits; see CLAUDE.md → "Running the integration suite
locally" for the `*_PERMIT_LIMIT` overrides.

### Frontend Testing

**What to test:**
- Utility functions (lib/)
- Custom hooks (hooks/)
- Component logic (when complex)

**Test file location:** Same folder as source, with `.test.ts(x)` suffix:
```
src/lib/analytics.ts
src/lib/analytics.test.ts
```

**When to write tests:**
- New utility function: always
- New hook with logic: yes
- Pure UI component: usually no (rely on E2E)
