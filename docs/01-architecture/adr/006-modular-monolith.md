# ADR-006: Modular Monolith Architecture

**Status**: Accepted — still in force. The structure below is the 2024 sketch; current projects are listed in [../README.md](../README.md#backend-projects).
**Date**: 2024-12

## Context

Choose architectural style for the backend.

Options:
1. Traditional layered monolith
2. Microservices
3. Modular monolith

## Decision

Use **Modular Monolith** with Clean Architecture layers.

## Structure

```
backend/src/
├── Api/           # Minimal API endpoints, middleware
├── Application/   # Services, business logic
├── Domain/        # Entities, enums, value objects
├── Infrastructure/# EF Core, storage, external services
├── Worker/        # Background ingestion jobs
└── Contracts/     # DTOs shared across layers
```

## Layer Rules

- Domain: No framework dependencies
- Application: Depends on Domain, uses interfaces
- Infrastructure: Implements interfaces, EF Core, storage
- Api: Orchestrates, depends on all

## Consequences

### Pros
- Simple deployment (1 API + 1 Worker)
- Fast iteration in MVP phase
- Easy to understand
- Shared database simplifies transactions

### Cons
- Must refactor for independent scaling
- Tighter coupling than microservices
- All code in one repo

## Notes

- Worker runs as separate container but shares Infrastructure
- Migration to microservices possible if scaling pressure appears
