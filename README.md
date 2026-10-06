# TextStack

[![Live — textstack.app](https://img.shields.io/badge/Live-textstack.app-2ea44f?logo=googlechrome&logoColor=white)](https://textstack.app)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![.NET](https://img.shields.io/badge/.NET-10-512BD4)](https://dotnet.microsoft.com/)
[![Docker](https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/mrviduus/textstack/pulls)
[![Android — closed beta](https://img.shields.io/badge/Android-closed%20beta-3DDC84?logo=android&logoColor=white)](https://play.google.com/apps/testing/app.textstack.mobile)
[![GitHub stars](https://img.shields.io/github/stars/mrviduus/textstack?style=social)](https://github.com/mrviduus/textstack/stargazers)

<p align="center">
  <img src="docs/demo.gif" alt="TextStack — select any technical phrase, get a 2-3 sentence explanation in your native language" width="800">
</p>

<p align="center">
  <strong>Finish English technical books in your native language.</strong><br>
  Select any term → 2-3 sentence explanation that knows the book's domain. A modern Kindle Word Wise, built for dense tech reading.
</p>

<p align="center">
  <a href="https://textstack.app"><img src="https://img.shields.io/badge/▶%20Open%20TextStack-textstack.app-2ea44f?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Open TextStack — read books in English with native-language translation"></a>
  <a href="https://play.google.com/apps/testing/app.textstack.mobile"><img src="https://img.shields.io/badge/Android-join%20the%20beta-3DDC84?style=for-the-badge&logo=android&logoColor=white" alt="Join the TextStack Android closed beta"></a>
</p>

<p align="center">
  <sub><b>The Android app is in closed testing and looking for readers.</b> Join, keep it installed, read something.<br>
  That is the whole job — Google needs 12 testers for 14 days before it can go public.</sub>
</p>

<p align="center">
  <b><a href="https://textstack.app">TextStack — read books in English with translation</a></b> ·
  <a href="https://dev.to/mrviduus/i-quit-designing-data-intensive-applications-ddia-three-times-heres-what-i-build-on-the-fourth-5bom">Why I built it</a> ·
  <a href="https://twitter.com/Rexetdeus">@Rexetdeus</a>
</p>

> ⭐ Star the repo if you've ever abandoned a technical book mid-way — it's the strongest signal that this kind of tool is worth building.

---

## The problem

I quit *Designing Data-Intensive Applications* three times. Not because it's
hard — I understood most of what was on the page. **The problem was the rest:
unfamiliar terms that broke the flow.** Eventual consistency. Attention
mechanism. B-tree. Writing each one down to look up later works until you
have 40 of them and you've lost the thread anyway.

Summarizing books away defeats the point. The only way to get deep
understanding is to read them — but the friction has to go.

## What TextStack does

**Tap any term → translation in your native language, aware of the book's
domain.** Tap "attention" in an ML book and you get *atención (mecanismo
de las redes neuronales)* in Spanish, *Aufmerksamkeit (Mechanismus in
neuronalen Netzen)* in German or *увага (механізм у нейромережах)* in
Ukrainian — not the everyday meaning of the word. Explanation mode (no
translation) is also available for native English readers who want the
term clarified instead of translated. Powered by OpenAI `gpt-4.1-nano`,
swap-in friendly — any `ILlmService` impl works. 18+ target languages
supported, led by Spanish, German, French, Portuguese, Italian and
Ukrainian.

Terms you don't recognize enter a **capped weekly SRS queue** — no infinite
backlog, no guilt. Common words and the top 15K English words are filtered
out; only technical vocabulary gets surfaced.

| Other tools | TextStack |
|---|---|
| Dictionary translation, word-by-word | Context-aware translation that knows the domain |
| Infinite SRS queue | Capped weekly — no review spiral |
| Generic content for casual learners | Built for dense technical books |
| Static Kindle Word Wise (2014) | LLM-powered (2026), 18+ target languages |

## Try it

1. [textstack.app](https://textstack.app) — sample chapters open without
   signup.
2. Tap any word you don't recognize.
3. That's the whole pitch.

---

## Features

**Reader**
- Kindle-like experience — themes (light/sepia/dark), fonts, fullscreen,
  keyboard shortcuts
- **Explain** — select any technical phrase → 2-3 sentence explanation in
  your native language, aware of the book's domain. Uses OpenAI
  `gpt-4.1-nano`. Includes a concrete analogy when the term is technical
  (see GIF above).
- Text selection extras — contextual translation in 18+ languages,
  dictionary fallback (Free Dictionary API), highlights
- TTS — Edge TTS via direct WebSocket (200+ voices, 0.75×–2.0× speed, two-
  layer cache)
- Offline reading — PWA with IndexedDB caching, download manager

**Vocabulary SRS**
- Auto-added while reading — sentence context, definition, translation
- 5 stages (New → Recognition → Recall → Context → Mastered)
- Capped weekly queue + LLM-generated distractors and hints (Ollama
  `gemma4:e2b`)
- Review modes: multiple choice, classic flashcard

**Library**
- 1,500+ curated technical and classic books (starter corpus, self-hostable)
- Your own uploads — EPUB / PDF, auto-parsed with metadata enrichment
- **PDF content-quality pipeline** — heuristic extraction first (instant,
  readable), then a gated Claude pass cleans flagged chapters in the
  background (running headers, fragmented paragraphs, line-wrap hyphens).
  Every fix is logged so deterministic rules can absorb recurring patterns
  and Claude usage trends down. See
  [architecture](docs/01-architecture/README.md#pdf-content-quality-pipeline).
- Reading progress sync, bookmarks, highlights, reading stats

**Mobile**
- React Native (Expo), Android on Google Play
- Offline-first, same UX as web

**Admin** ([textstack.dev](https://textstack.dev))
- Book/author/genre CRUD, chapter editor, ingestion queue
- SSG rebuild, auto-publish, SEO backfill

---

## MCP server

TextStack is also a **Model Context Protocol (MCP) server** — connect it to
Claude Desktop, Cursor, or ChatGPT and your AI client can search the library,
read chapters, and manage your highlights and vocabulary. Run it locally
(`dotnet tool install -g TextStack.Mcp`) or point a client at the hosted endpoint `https://textstack.app/mcp`.

Setup, the 18 tools, auth, and troubleshooting: [docs/05-features/mcp.md](docs/05-features/mcp.md).

---

## Tech stack

| Layer | Technology |
|-------|-----------|
| Backend | ASP.NET Core (.NET 10), Minimal APIs |
| Database | PostgreSQL 16 + EF Core (snake_case) |
| Search | PostgreSQL FTS |
| Web | React 19, Vite, pnpm |
| Mobile | React Native (Expo 55) |
| LLM | OpenAI `gpt-4.1-nano` (explanations + translation) + Ollama `gemma4:e2b` (distractors, local) |
| TTS | Edge TTS (WebSocket, no API key) |
| SSG | Puppeteer prerender, nginx serves static first |
| Telemetry | OpenTelemetry → Aspire Dashboard |
| Infra | Docker Compose, Cloudflare Tunnel, nginx |

**Architecture**: `API → Application → Domain ← Infrastructure` (modular
monolith). Worker runs ingestion + SRS scoring + SSG jobs.

---

## Quick start

```bash
git clone https://github.com/mrviduus/textstack
cd textstack
cp .env.example .env            # edit with real values
docker compose up --build       # ~3 min cold start
```

| Service | URL |
|---------|-----|
| Web | http://localhost:5173 |
| API | http://localhost:8080 · [Scalar docs](http://localhost:8080/scalar/v1) |
| Admin | http://localhost:81 |
| Aspire (opt-in) | http://localhost:18888 — `docker compose --profile observability up` |

**Prerequisites**: Docker, .NET 10 SDK, Node.js 20+, pnpm.

---

## Development

```bash
# Local dev (no Docker)
dotnet run --project backend/src/Api
pnpm -C apps/web dev           # http://localhost:5173
pnpm -C apps/admin dev         # http://localhost:81

# Mobile
cd apps/mobile && npx expo start

# Tests
dotnet test                     # backend (unit + integration + extraction + search)
pnpm -C apps/web test           # Vitest
pnpm -C apps/web test:e2e       # Playwright

# Lint / format
dotnet format textstack.sln
```

Full command reference: [CLAUDE.md](CLAUDE.md).

---

## Ops / self-hosting

- [Deployment](docs/03-ops/deployment.md) — Cloudflare Tunnel + nginx + Docker
- [Backup & Restore](docs/03-ops/backup.md) — `make backup`, GHA daily dumps
- [Uptime Monitoring](docs/03-ops/uptime-monitoring.md) — UptimeRobot probes
- [Incident Runbook](docs/03-ops/incident-runbook.md) — first-response for
  common outages
- [infra/scripts](infra/scripts/README.md) — long-running pollers

---

## Contributing

Feedback, bug reports, and PRs welcome. See [CONTRIBUTING.md](CONTRIBUTING.md)
(if it exists yet — otherwise open an issue and we'll sort it out).

**Star the repo** if this resonates. That's the only signal I have right now
that I'm building the right thing.

---

## License

**Why AGPL?** TextStack is built to be self-hosted and modified freely by
individuals, teams, and small communities. AGPL ensures that if someone
runs a modified version as a public service, those modifications are
shared back. If your organization needs a non-AGPL license for a
commercial fork or hosted product, see the commercial license note below.

[GNU Affero General Public License v3.0](LICENSE) © 2026 Vasyl Vdovychenko.

TextStack is free and open-source software. You may use, modify, and
self-host it freely for personal, internal, or community purposes. If you
modify TextStack and run it as a network-accessible service, AGPL-3.0
requires you to publish your modifications under the same license.

**Commercial license available** for organizations that need to use
TextStack without AGPL obligations (e.g. proprietary forks, hosted
commercial services). Contact: mrviduus@gmail.com.

- Source code: AGPL-3.0
- Standard Ebooks corpus (included in seed data): CC0 / public domain
- Edge TTS: used under Microsoft's Edge Read Aloud terms
- Third-party deps: their respective licenses

---

## Why the name

A stack of books. A stack of text. Read through it.
