# Contributing to TextStack

Thanks for the interest. This is a solo project right now, but feedback, bug
reports, and PRs are welcome.

## Quick ways to help

1. ⭐ **Star the repo** — the strongest signal I have about whether this is
   useful.
2. 🐛 **Report a bug** — [open an issue](../../issues/new/choose) with the
   bug template.
3. 💡 **Suggest a feature** — especially if you're reading AI/ML books and
   the reader is missing something.
4. 📝 **Try it + send feedback** — [textstack.app](https://textstack.app),
   then ping me on [@Rexetdeus](https://twitter.com/Rexetdeus) or the
   contact form on the site.

## Running locally

See the [README Quick start](README.md#quick-start). Everything runs in
Docker via `docker compose up --build`.

For day-to-day dev without Docker, see [CLAUDE.md](CLAUDE.md) — full command
reference (tests, migrations, mobile, lint).

## Before sending a PR

1. **Open an issue first** if the change is > ~30 LoC or touches multiple
   files. Cheaper to align on direction than on code.
2. **Branch from `main`** with a descriptive name:
   `feat/<short>`, `fix/<issue>`, `docs/<area>`, `refactor/<area>`, `test/<what>`.
3. **Tests** — add/update tests for the behavior you changed.
   ```bash
   dotnet test                          # backend (unit + integration + extraction + search)
   pnpm -C apps/web test                # web unit (Vitest)
   pnpm -C apps/web test:e2e            # Playwright (needs services up)
   ```
4. **Lint** — `dotnet format textstack.sln` for backend. Web/admin have no
   enforced formatter yet; match surrounding style.
5. **Conventional commit subject** — `type(scope): summary`. Common types:
   `feat`, `fix`, `refactor`, `docs`, `presale`. One logical change per
   commit; rebase locally if things got noisy.

## PR expectations

- **Title**: short, imperative, < 70 chars.
- **Body**: follow the template (filled automatically when you open the PR).
- **Scope**: one concern per PR. Drive-by refactors go in a separate PR.
- **Breaking changes** — call them out. Include a migration note.
- **Screenshots / GIFs** for UI changes. Required, not optional.

## Code style

- **Backend** — idiomatic C# / .NET 10. Minimal APIs, EF Core. Snake-case
  in DB (handled by EF naming convention). Nullable-aware. Test naming:
  `{Method}_{Scenario}_{Expected}`.
- **Frontend** — React 19 functional components, hooks. CSS variables for
  theming (no CSS-in-JS). No Redux/Zustand — React Context is enough.
- **Mobile** — Expo 57, React Native 0.86. Match web patterns where
  possible.
- **Editor** — optional. Neovim users: [mrviduus/nvim-config](https://github.com/mrviduus/nvim-config)
  is a Visual Studio-style LazyVim setup; `projects/textstack.lazy.lua` there matches this repo's
  formatting (C# via Roslyn like `dotnet format` in CI, no format-on-save for the frontend).

## What I care about

- **Reader UX** — smooth scroll, fast word-tap response, offline works.
- **SRS quality** — capped queue, anti-spiral tiers, explanations that
  actually help the reader.
- **Performance** — ingestion speed, SSG prerender time, reader cold-start.
- **Legal hygiene** — only public domain / CC0 / user-owned content.

## What I'll probably push back on

- Scope creep that doesn't serve deep reading.
- Adding new LLM providers just to have them — we have Ollama (local) and
  plans for Claude; keep that surface small.
- Reintroducing features I deliberately removed.

## Architecture at a glance

```
backend/src/
  Api/            # Minimal APIs, middleware
  Application/    # Business logic, interfaces
  Domain/         # Entities, enums (pure C#)
  Infrastructure/ # EF Core, storage, adapters
  Worker/         # Ingestion + SSG polling + GC
  Extraction/     # EPUB/PDF parsers
  Search/         # Postgres FTS

apps/
  web/            # Public reader (React + Vite)
  admin/          # Admin panel (React + Vite)
  mobile/         # Mobile app (Expo)
```

Deeper detail: [docs/01-architecture/](docs/01-architecture/).

## Contributor License Agreement

By submitting a pull request to this repository, you agree that:

1. Your contribution is your original work or you have the right to
   submit it under the project license.
2. Your contribution is licensed under AGPL-3.0, the same license as
   the rest of the project.
3. You grant Vasyl Vdovychenko (the project copyright holder) a
   perpetual, worldwide, non-exclusive, royalty-free license to
   relicense your contribution under any license, including commercial
   proprietary licenses, for the purpose of dual-licensing TextStack to
   commercial customers.

This CLA exists so the project can offer commercial licenses alongside
the AGPL-3.0 community version, which helps fund continued development.

If you do not agree with this CLA, do not submit pull requests. You can
still file issues, fork the project, and run your own version under
AGPL-3.0.

## Code of Conduct

Be kind. Assume good faith. That's it.

## Contact

- Twitter: [@Rexetdeus](https://twitter.com/Rexetdeus)
- Email via [textstack.app](https://textstack.app) contact form
- GitHub Discussions (broader questions)

Thanks for being here.
