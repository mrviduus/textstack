# TextStack — Automated Testing Strategy (MVP → Hardening)

Goal: **everything is automatically testable** (CI runs it), with fast feedback locally and strong confidence before deploy.

---

## Quick Reference

### Backend Tests
```bash
dotnet test                                    # All tests
dotnet test tests/TextStack.UnitTests          # Unit only
dotnet test tests/TextStack.IntegrationTests   # Integration (needs Docker)
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
| Unit | xUnit, FluentAssertions | Vitest |
| Integration | WebApplicationFactory + Testcontainers | (not used yet) |
| E2E | Playwright (planned) | Playwright (planned) |

### Backend Testing

**What to test:**
- Domain logic (entities, value objects)
- Service methods (business logic)
- API endpoints (integration)
- Search queries

**Naming convention:**
```
{MethodName}_{Scenario}_{ExpectedResult}
GetAuthors_WithLanguageFilter_ReturnsFilteredResults
```

**Test file location:**
```
tests/
  TextStack.UnitTests/           # Pure logic, no DB
  TextStack.IntegrationTests/    # API + DB
  TextStack.Extraction.Tests/    # Book parsing
  TextStack.Search.Tests/        # Search logic
```

### Frontend Testing

**What to test:**
- Utility functions (lib/)
- Custom hooks (hooks/)
- Component logic (when complex)

**Test file location:** Same folder as source, with `.test.ts(x)` suffix:
```
src/lib/canonicalUrl.ts
src/lib/canonicalUrl.test.ts
```

**When to write tests:**
- New utility function: always
- New hook with logic: yes
- Pure UI component: usually no (rely on E2E)

---

## 1) Testing principles

- **Testing pyramid**: many fast tests (unit/component) → fewer integration → few end‑to‑end.
- **Deterministic**: tests must not depend on real time, random, network, or shared state.
- **Hermetic environments**: CI spins up its own DB + services via Docker.
- **Test data is disposable**: every run can recreate DB + filesystem storage.
- **Observable failures**: on failure, we always capture logs + screenshots + traces.

---

## 2) Target architecture for tests

Services (Docker Compose):
- **db**: PostgreSQL
- **api**: ASP.NET Core API
- **worker**: ingestion worker
- **web**: React app

Test environments:
- **Local**: developers run a test compose stack.
- **CI**: dedicated compose stack per pipeline run.

State:
- **DB**: seeded per test run (or per test suite), resettable.
- **Filesystem storage**: mounted to a temp directory per run (never shared).

---

## 3) Test layers (what we test and why)

### A) Unit tests (fast, pure, lots)
**What**
- Domain logic (slugging, language rules, permissions, progress locator math, etc.)
- Utility code (parsers, validators, mappers)
- Pure ingestion transformations (without touching real DB/files)

**How**
- xUnit + FluentAssertions
- Use **fake clocks** and deterministic IDs (Guid provider).

**Rule**
- No network. No DB. No filesystem (unless using in‑memory abstractions).

---

### B) Component tests (API/service-in-process)
**What**
- API controllers/handlers with real DI graph, but stub external I/O
- Validation, auth policies, error formats

**How**
- ASP.NET Core `WebApplicationFactory`
- Replace services via DI for fakes (clock, storage, message queue)

**Rule**
- Still fast. Minimal I/O.

---

### C) Integration tests (API ↔ Postgres ↔ storage)
**What**
- API + real Postgres schema (migrations) + real queries
- Storage writes/reads (covers, originals, cached HTML if used)
- Ingestion worker “happy path”: upload → job created → worker extracts chapters → API serves HTML

**How**
- Run Postgres via **Testcontainers** (recommended) OR dedicated docker-compose test stack
- Apply migrations automatically at test start
- Use temp folder for storage mount

**Must include**
- **Migration tests**: apply all migrations from scratch on empty DB
- **Backward compatibility checks** (later): migrate from previous version snapshot

**Reset strategy**
- Best: recreate DB container per test class/suite (simple + reliable)
- Alternative: truncate tables between tests with a reset tool (fast, but more complex)

---

### D) Contract tests (stability between web ↔ api)
**What**
- API response shapes used by the web reader/search pages

**How**
- Generate OpenAPI from API and validate it in CI
- Add “contract assertions” in integration tests (schemas, required fields)

**Rule**
- Breaking change requires explicit versioning plan.

---

### E) End‑to‑End tests (E2E) — user flows
**What**
1. Public browsing: homepage → book page → chapter page
2. Reader: open chapter → paginate/scroll → save progress (logged in)
3. Search: query → results → open chapter from result
4. Notes/bookmarks: create → persist → re-open
5. Admin flow (separate tool): upload book → ingestion completes → appears publicly

**How**
- **Playwright** (recommended): cross‑browser + tracing + screenshots
- Run against the compose stack in CI
- Use seeded fixtures (known books) to avoid flaky expectations

**Artifacts on failure**
- Video (optional), screenshots, Playwright trace, server logs

**Flake controls**
- No arbitrary sleeps; always wait for specific selectors/network idle
- Keep E2E set small; push most coverage down to integration/component tests

---

### F) UI/UX quality tests (automated)
These are not “manual QA”; they run in CI.

**1) Visual regression**
- Playwright screenshots of key pages:
  - book page, chapter page, reader UI, search results
- Compare with baseline (small diffs only)
- Gate on major layout breaks

**2) Accessibility (a11y)**
- Run **axe-core** checks in Playwright on key pages:
  - headings structure, aria labels, contrast warnings, focus order basics

**3) Performance (web)**
- Lighthouse CI (or Playwright + performance budgets):
  - LCP/CLS budgets, JS bundle size budget

**4) SEO correctness**
- Assert:
  - server returns real HTML for book/chapter pages (not blank shell)
  - correct `<title>`, meta description, canonical, hreflang (en/uk)
  - sitemap includes expected URLs and lastmod format
  - robots.txt present and sane

---

### G) Ingestion worker test strategy (critical)
Ingestion is the “content factory”; we need high confidence here.

**Fixture library**
- Curate a small set of public-domain fixtures:
  - 2–3 EPUBs (simple, complex)
  - 1 PDF (if PDF ingestion is supported)
  - 1 FB2 (if supported)
- Store fixtures in repo under `tests/fixtures/` (small size)

**Golden master tests (snapshot)**
- For each fixture:
  - parse → chapter list snapshot
  - chapter HTML snapshot (normalized)
- Snapshots live in repo so changes are reviewed in PRs.

**Normalization rules**
- remove timestamps/ids
- normalize whitespace
- stable ordering

**Property-based tests (optional later)**
- Generate random valid chapter structures and ensure:
  - stable slugging
  - no duplicate chapter slugs per edition
  - HTML sanitizer never emits forbidden tags

---

## 4) Test data strategy (DB + storage)

### A) DB seeding
- Use a **Test Data Builder** / factory:
  - `CreateWork()`, `CreateEdition(language, title)`, `CreateChapter()`, `CreateUser()`
- Always return IDs to the test; avoid “magic lookup” by title.

### B) Per-run deterministic fixtures
- Provide seed scripts for:
  - 1 sample Work with EN+UK editions
  - 10–20 chapters
  - 1 test user
- Ensure every E2E run sees the same content.

### C) Storage isolation
- For every test run:
  - create a temp folder like `./.test-storage/<run-id>/`
  - mount it into containers
  - delete after tests (CI always cleans workspace)

### D) Optional: prod-like data (later)
- If needed: anonymized snapshot or synthetic generator
- Never put real copyrighted content in tests.

---

## 5) What MUST be covered before MVP launch

**Backend**
- [ ] Migrations apply from scratch
- [ ] Publish/unpublish visibility rules
- [ ] Public endpoints return correct status codes
- [ ] Search returns relevant results and is safe against injection
- [ ] Progress + notes save and reload

**Ingestion**
- [ ] Upload → job created
- [ ] Worker processes job and marks status
- [ ] Chapters extracted and served
- [ ] Failures are recoverable and recorded (job state)

**Web**
- [ ] Chapter page renders real content
- [ ] Reader keeps position reliably
- [ ] Basic a11y checks pass on core pages
- [ ] Visual snapshots for core pages

---

## 6) CI pipeline outline (fully automated)

Stages (run on every PR):
1. **Lint + format**
   - C#: dotnet format / analyzers
   - Web: ESLint + prettier
2. **Unit + component tests**
   - `dotnet test` (fast suite)
   - `npm test` (if using component tests)
3. **Integration tests**
   - Start Postgres (Testcontainers or compose)
   - Apply migrations
   - Run API integration tests
4. **E2E + UI/UX**
   - Start full compose stack (db + api + worker + web)
   - Seed DB + fixtures
   - Playwright E2E + a11y + visual snapshots
   - Upload artifacts on failure
5. **Security + dependencies (baseline)**
   - Dependency audit (npm + dotnet)
   - Basic SAST

On merge to main:
- run full suite again + build images + deploy (later)

---

## 7) Folder structure suggestion

```
/tests
  /TextStack.UnitTests
  /TextStack.Api.ComponentTests
  /TextStack.IntegrationTests
  /TextStack.E2E
    /fixtures
    /snapshots
```

---

## 8) Practical tool recommendations (fit our stack)

- .NET: **xUnit**, FluentAssertions, WebApplicationFactory
- DB: **Testcontainers for .NET** (or compose test stack)
- E2E + visual + a11y: **Playwright**
- Web checks: ESLint/Prettier, optional Lighthouse CI
- Snapshots: text snapshots for ingestion outputs + Playwright screenshots

---

## 9) “Definition of Done” for any feature

A feature is not done until:
- [ ] Unit tests cover core logic
- [ ] Integration test covers DB/storage behavior if used
- [ ] If user-visible, E2E test covers the flow OR is explicitly justified not to
- [ ] No flaky waits; tests deterministic
- [ ] Logs/trace are helpful when it fails

---

## 10) Next actionable steps

1. Add test projects and CI wiring (unit/component first).
2. Add Postgres Testcontainers + migration test.
3. Add Playwright E2E with one “golden flow”.
4. Add ingestion fixture + golden master snapshot.
5. Add a11y + visual snapshots for core pages.
