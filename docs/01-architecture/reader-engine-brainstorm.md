# Reader engine — brainstorm (2026-10-05)

**Status: discussion, no decision.** Owner: "we are just brainstorming, don't make conclusions."
Return to it after R3 and the Play production launch. An ADR comes only when the owner decides.

## Why it came up

Web (`apps/web`) and mobile (`apps/mobile`) each have their own reader: two scroll/restore paths,
two highlight engines (mobile's is untyped ES5 in a string — review gap #24), two position models.
The R1/R2 bug hunt fixed 47 findings, and most of them were the same bug written twice.

## Two separate parts

| Part | What it does | Where it runs | Language |
|---|---|---|---|
| **Parser / converter** | EPUB/PDF (later more formats) → chapters + a manifest | server, today | C# (keep) |
| **Reader engine** | renders a publication, owns pagination/scroll, positions, decorations (highlights, vocab, search), emits events | in the app (browser, WebView, later desktop) | TypeScript |

The engine has **no DB and no API calls**. The host app (web, mobile) does storage and sync.

## Contract (sketch)

- **Publication**: manifest (metadata, reading order, resources), close to Readium's RWPM.
- **Locator**: `{ href/chapter, progression, text: { before, highlight, after } }`, matching our
  TextQuoteSelector-style anchors (ADR-015).
- Defined once as JSON Schema → C# and TS types are generated, so the parser and the engine can't drift.
- Engine API: `open(publication)`, `goTo(locator)`, `decorate(group, items)`, events
  `relocated`, `selection`, `wordTap`.

## Server or device?

Hybrid local-first: the phone is home (reading never waits for the network, the existing rule),
the server is the sync hub, and the MCP bridge needs the text there. So parsing stays on the server
for now; parsing on the device is an option later, with no change to the engine.

## Repo and packaging

- Start as `packages/reader-engine` in this monorepo (workspace package like `@textstack/shared`),
  with its own tests and README, and **no imports from `apps/*`**.
- Agents can work on it alone because the folder is a boundary; a separate repo isn't needed for that.
- Publish to npm later if it's open-sourced or a desktop app needs it, with no code move.
- Rust/C++: parked. Rust is risky for parsing here; maybe one day for a native/desktop core.

## Don't start from zero

Open-source engines to evaluate before writing a core: **foliate-js** (MIT), **Readium TS toolkit**
(BSD), epub.js (older). The question is whether we reuse 30% or 80%. See `reader-engine-evaluation.md`
(in progress).

## Rough size and order (if approved)

About 2–3 weeks in small PRs: ADR → Locator/Publication schema → move mobile `readerHtml`/`readerBridge`
JS into TS in the package → web adopts it → one state machine for restore/save.

## Open questions

- Reuse foliate-js parts, base on it, or only borrow ideas?
- Formats beyond EPUB/PDF (MOBI/AZW3/FB2/CBZ) — when?
- Publish to npm / open-source: ever?
- Desktop: which shell (Tauri/Electron), and does that change anything?
