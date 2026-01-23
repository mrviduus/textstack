# Contributing to TextStack

## Getting Started

### Prerequisites
- Docker & Docker Compose
- Node.js 18+ & pnpm
- .NET 10 SDK

### Dev Setup
```bash
docker compose up --build
```

| Service | URL |
|---------|-----|
| API | http://localhost:8080 |
| Web | http://localhost:5173 |
| Admin | http://localhost:81 |

## Branch Naming

```
feat/short-description    # new feature
fix/issue-description     # bug fix
docs/what-changed         # documentation
refactor/what-changed     # code restructure
test/what-covered         # tests
```

## Commit Messages

Format: `type(scope): description`

```
feat(reader): add keyboard shortcuts
fix(search): handle empty query
docs(api): update endpoint examples
refactor(auth): extract token validation
test(ingestion): add epub fixture
```

## Pull Request Process

1. Create branch from `main`
2. Make changes in small, focused commits
3. Run tests: `dotnet test`
4. Run type-check: `pnpm -C apps/web build`
5. Create PR with description:
   - What changed
   - Why
   - How to test

### PR Template

```markdown
## Summary
Brief description of changes.

## Changes
- List specific changes

## Testing
- [ ] dotnet test passes
- [ ] Manual testing done

## Screenshots (if UI change)
```

## Code Style

### Backend (C#)
- Follow existing patterns in codebase
- Use `record` for DTOs
- Keep endpoints minimal, logic in services
- Run `dotnet format` before commit

### Frontend (TypeScript/React)
- Functional components with hooks
- Extract reusable logic to custom hooks
- Keep components under 200 lines when possible
- Use TypeScript strictly (no `any`)

## Testing

### Backend
```bash
dotnet test                                    # all tests
dotnet test tests/TextStack.UnitTests          # unit only
dotnet test tests/TextStack.IntegrationTests   # integration
```

### Frontend
```bash
pnpm -C apps/web test       # run tests
pnpm -C apps/web test:watch # watch mode
```

## Working with the Codebase

### Key Principle: Small Slices
- Work in small, independently mergeable chunks
- Each PR should be reviewable in one sitting
- If scope grows, split into multiple PRs

### Before Starting
1. Read relevant docs in `docs/`
2. Understand existing patterns
3. Check for similar implementations to follow

### When Stuck
- Check `CLAUDE.md` for codebase guidance
- Review existing implementations
- Ask questions in PR/issues

## Good First Issues

Look for issues labeled `good-first-issue`:
- Documentation improvements
- Small bug fixes
- Test coverage additions
- UI polish

## Architecture Overview

```
backend/
  src/Api/        # Endpoints, middleware
  src/Domain/     # Entities
  src/Application/ # Services, business logic
  src/Infrastructure/ # DB, storage

apps/
  web/    # Public reader site
  admin/  # Admin panel
```

See `docs/01-architecture/` for details.
