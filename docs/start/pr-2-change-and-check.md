# Change and check

Lesson 2 of 3 in [Ship a first pull request](first-pr.md). About 20 minutes.

In this lesson you make the change, run the checks and save your work.

## Steps

1. **Make the change.** One concern per pull request. If your change alters a command, a setting,
   a route or a setup step, edit the docs page that states it in the same pull request.

2. **Run the checks for the part you touched.**

   - You changed `backend/`:

     ```bash
     dotnet test tests/TextStack.UnitTests
     dotnet format textstack.sln --verify-no-changes
     ```

   - You changed `apps/web/`:

     ```bash
     pnpm -C apps/web test
     pnpm -C apps/web build
     ```

   - You changed `apps/admin/`:

     ```bash
     pnpm -C apps/admin build
     ```

   - You changed `apps/mobile/`:

     ```bash
     pnpm --filter mobile typecheck
     ```

   - You changed `docs/` or any `.md` file:

     ```bash
     node scripts/check-doc-links.mjs
     ```

   You should see: every command ends without errors. The backend unit tests print `Passed!` with
   zero failed.

3. **Commit.** One logical change per commit. The first line is `type(scope): summary`. The types
   are `feat`, `fix`, `refactor`, `docs` and `test`.

   ```bash
   git add -A
   git commit -m "fix(reader): keep the position after a font change"
   ```

## If something goes wrong

- **`dotnet format` reports changes.** Run `dotnet format textstack.sln` without
  `--verify-no-changes`, then commit the result.
- **`dotnet test` with no project name fails with connection errors.** It also runs the
  integration tests, which need the running backend. Run the unit test project only. CI runs the rest.

## Check yourself

- [ ] My change does one thing.
- [ ] The checks for my part ended without errors.
- [ ] My work is committed.

## Next

[Lesson 3: Open the pull request](pr-3-open-the-pull-request.md).
