# Ship a first pull request

You get: a pull request that passes CI and is ready for review. Time: about 30 minutes for a small
change. Before you start: the app runs on your machine ([Run it locally](run-locally.md)), you have a
GitHub account, and you read the [contributor agreement](../../.github/CONTRIBUTING.md#contributor-license-agreement).

A **pull request** (PR) is your change, offered to the project for review. **CI** is the set of
automatic checks GitHub runs on every PR.

## Steps

1. **Pick an issue, or open one.** Every change starts from an issue. Look at the
   [open issues](https://github.com/mrviduus/textstack/issues), or
   [open a new one](https://github.com/mrviduus/textstack/issues/new/choose) and say what you want to
   change. For anything bigger than a small fix, wait for an answer before you write code.

2. **Fork the repository and clone your fork.** A fork is your own copy on GitHub.

   ```bash
   gh repo fork mrviduus/textstack --clone
   cd textstack
   ```

3. **Create a branch from `main`.** Name it `fix/<what>`, `feat/<what>` or `docs/<what>`.

   ```bash
   git switch -c fix/short-name
   ```

4. **Make the change.** One concern per PR. If the change alters a command, an environment variable,
   a route, a flag or a setup step, edit the docs page that states it in the same PR.

5. **Run the checks for the area you touched.**

   | You changed | Run |
   |---|---|
   | `backend/` | `dotnet test tests/TextStack.UnitTests` and `dotnet format textstack.sln --verify-no-changes` |
   | `apps/web/` | `pnpm -C apps/web test` and `pnpm -C apps/web build` |
   | `apps/admin/` | `pnpm -C apps/admin build` |
   | `apps/mobile/` | `pnpm --filter mobile typecheck` |
   | `docs/` or any `.md` | `node scripts/check-doc-links.mjs` |

   You should see: every command ends without errors. The backend unit tests print
   `Passed!` with zero failed.

6. **Commit.** One logical change per commit. The subject line is `type(scope): summary`, for
   example `fix(reader): keep the position after a font change`. Types: `feat`, `fix`, `refactor`,
   `docs`, `test`.

   ```bash
   git add -A
   git commit -m "fix(reader): keep the position after a font change"
   ```

7. **Push and open the PR.**

   ```bash
   git push -u origin fix/short-name
   gh pr create --fill
   ```

   Fill in the template. In the description write `Fixes #<issue number>`, and fill the `Docs:` line
   with `updated` or `not affected`.

   You should see: a link to your new PR.

8. **Name the area.** Each PR carries one area label: `reading`, `library`, `highlights`,
   `vocabulary`, `assistant`, `account`, `data`, `ops` or `documentation`. Only maintainers can set labels, so write the area in the
   PR description. The `area-label` check stays red until the maintainer adds it.

## It worked when

- Your PR is open and every CI check except `area-label` is green.
- The description links the issue and names the area.

## Troubleshooting

| What you see | What to do |
|---|---|
| `dotnet format` reports changes | Run `dotnet format textstack.sln` without `--verify-no-changes`, then commit the result. |
| The `area-label` check is red | Nothing. A maintainer adds the label. |
| The `docs-links` check is red | A link in a `.md` file points at a file that does not exist. Run `node scripts/check-doc-links.mjs`; it prints the file and line. |
| `dotnet test` without a project name fails with connection errors | It also runs the integration tests, which need the running stack. Run the unit test project only; CI runs the rest. |
| A CI check fails on something you did not touch | Say so in the PR. Some checks are flaky; a maintainer re-runs them. |

## Next

[Understand the architecture](../architecture/index.md) before a larger change.
