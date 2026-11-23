# ADR-034 — Modular monolith, enforced by architecture tests

**Status:** Accepted · **Date:** 2026-11-22 · **Builds on:** [ADR-006](006-modular-monolith.md), [ADR-028](ADR-028-dapper-and-repositories.md) · **Issue:** #1441

## Context

The backend is one deployable split into layers: `Api → Application → Domain ← Infrastructure`, with the
`Worker` as a second composition root. Application and Domain are organised in feature folders
(`Library`, `Reading`, `Annotations`, `Vocabulary`, `Discussion`, `Identity`, …), each owning its
repository ports (`I*Repository`, implemented by Dapper classes in Infrastructure).

The rules lived only in ADR-006 and in review. Project references stop the worst cycles, but not a
package reference in the wrong layer, a namespace leak, or a leftover name from the V2 program.

## Decision

`tests/TextStack.UnitTests/ArchitectureTests.cs` checks the compiled assemblies with NetArchTest.Rules.
It runs in the normal `dotnet test`; there is no separate CI job. Each rule is one test whose failure
lists the offending types:

1. **Domain** depends on no other project of ours (Application, Infrastructure, Api, Worker, Contracts,
   `TextStack.*`) and on no Dapper or Npgsql.
2. **Application** uses no Dapper and no `Microsoft.AspNetCore`.
3. **Infrastructure** never depends on Api or Worker.
4. **A feature uses only its own repository ports.** An `I*Repository` in `Application/<Feature>` is
   used by that feature, by Infrastructure (the implementation) and by the Api/Worker composition
   roots. Another feature goes through the owner's public port instead: Library's `IBookAccess` (book
   ownership, the one place that check lives) and Transitional's `IChapterLookup` (chapter text). The
   four cross-feature uses left today are on a named allow-list, one reason each; the goal is zero (#1498). A new cross-feature use fails, naming
   `user -> port`.
5. **No type is named `V2*`**: the V2 program is over, its names are gone.

## Consequences

- A layer leak fails a unit test locally and in CI, with the type names in the message.
- A rule change is a code change to one file, reviewed like any other.
- The tests read IL, so a compile-time-only use (`nameof`, a `using` with no use) is not caught.
- Splitting a project or adding a layer means adding it to the root list in the test.
