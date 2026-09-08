# MCP server — connect TextStack to your AI client

TextStack is a **Model Context Protocol (MCP)** server. Connect it to Claude
Desktop, Cursor, ChatGPT, or any MCP client, and the assistant can search the
TextStack library, read chapters, ask grounded questions about a book you're
reading, and manage your own highlights and vocabulary — all from the chat.

This is the canonical reference. The [package README](https://www.nuget.org/packages/TextStack.Mcp)
and the [landing page](https://textstack.app/en/mcp) point here.

## The 14 tools

The server exposes 14 tools. The public ones need no auth; the user-scoped ones
require you to be signed in (see [Authentication](#authentication)).

**Two halves, two identifiers.** The public catalog is made of `Edition`s and is
addressed by `editionId`. The books you uploaded are `UserBook`s — a separate
aggregate, with its own chapter and chunk tables — and are addressed by `bookId`.
An upload has no `editionId` and cannot be given one. Passing a `bookId` to
`ask_book` is a 404, and to `list_my_highlights` an empty list, which reads like
an empty library rather than a wrong id. The tool names carry the split: `_my_`
means your uploads.

| Tool | What it does | Auth |
|------|--------------|------|
| `search_books` | Search the public library for books and chapters matching a query. | Public |
| `get_book` | Fetch a catalog book by slug: its `editionId` (for `ask_book`), metadata, authors, genres, and chapter list. | Public |
| `get_chapter` | Fetch a chapter's plain text (HTML stripped, length-capped) plus its number, title, and prev/next slugs. | Public |
| `search_my_library` | Full-text search across the books **you uploaded**. Returns one hit per book with its `bookId` and best-matching chapter. Needs no RAG index. | User |
| `get_my_book` | Fetch one of your uploads by `bookId`: metadata + full chapter list, each chapter carrying its `chapterId`. | User |
| `get_my_chapter` | Fetch one chapter of your upload as plain text, plus its `chapterId` and prev/next slugs. | User |
| `save_my_highlight` | Highlight a passage in a book you uploaded. Matched against the chapter text, so the quote must be verbatim. Capped at 200 per book. | User |
| `list_my_book_highlights` | List the highlights already in a book you uploaded. | User |
| `save_insight` | Write a conclusion back into a book — against a `chapterSlug`, or against the whole book when omitted. Saving again for the same chapter replaces it. | User |
| `get_my_insights` | Read back everything already worked out about a book, in reading order. | User |
| `list_my_highlights` | List your highlights for a given edition. | User |
| `list_my_vocabulary` | List your saved vocabulary words, optionally filtered by SRS stage or search. | User |
| `ask_book` | Ask a question about a book you're reading; spoiler-safe (answers only from chapters you've already read). | User |
| `save_highlight` | Save a passage (text + optional color/note) to your highlights for a catalog book chapter. | User |

All 14 tools are always listed regardless of whether you're signed in — only a
user-scoped *call* fails with a clean "authentication required" message when no
token is available.

A typical catalog chain is `search_books → get_book` (to get the `editionId` /
chapter ids) `→ get_chapter` / `ask_book` / `save_highlight`. The chain for your
own uploads is `search_my_library → get_my_book` (to get the chapter ids)
`→ get_my_chapter`.

## Limits on what an assistant may write

**200 highlights per book.** Not a resource limit — a highlight row is tiny. A client told to "go
through the book and mark what matters" can place one per paragraph in a single pass, and a book
marked end to end is a book with no marks. The cap counts only highlights written over MCP
(`anchor_json->>'source' = 'mcp'`), so a person who highlights heavily is never affected, including
on a book an assistant has also marked.

**On a PDF, a highlight is saved but not painted.** The reader shows PDFs as the original document
(ADR-012), where a highlight is drawn from page geometry an MCP client cannot produce. The highlight
is stored, listed by `list_my_book_highlights`, and shown on the Highlights page — it just does not
appear over the page. `get_my_book` reports `rendersAsOriginalPdf` so the assistant can say so
instead of leaving you looking for a mark that is not there. About half the uploaded library is PDF.

**Insights are capped by shape, not by count**: one per (you, book, chapter), because a save
replaces. There is no way to accumulate them.

## Writing conclusions back into a book

TextStack does not try to be your chat. Your assistant already has your profile,
your memory, and a year of conversation; a copy of that is not something we can
build, and competing with it is not the point. **The reasoning happens there. The
result comes back here.**

So after a session — "what did I understand, what didn't I, what's worth marking"
— the assistant writes the outcome into the book, and it is still there next
month:

- a passage → `save_my_highlight`, which the reader paints like any other highlight;
- a chapter → `save_insight` with a `chapterSlug`;
- the whole book → `save_insight` with no `chapterSlug`.

A study конспект is then not a separate frozen document but the assembly of those
in reading order. Run the pass again and it is current, because one insight is
kept per (you, book, chapter) and a save replaces.

The key is the chapter **slug**, not its id: re-ingesting a book deletes and
recreates every chapter, so anything holding a `chapterId` comes unstuck. Same
reason the reading position is a text anchor (ADR-015).

`get_my_insights` is the other half, and the more important one — call it at the
START of a session about a book that has been discussed before. It is what stops
the next conversation repeating the last one.

## Quick start — Claude Desktop

The most common path: run the published .NET global tool locally over stdio.

### 1. Install the tool

```bash
dotnet tool install -g TextStack.Mcp
```

This installs the `textstack-mcp` command. Runtime: .NET 10 SDK (the package
rolls forward to future majors). On .NET 10 you can also run it without
installing via `dnx textstack-mcp`.

### 2. Add it to `claude_desktop_config.json`

> **Use the absolute path to the command.** Claude Desktop is a GUI app and
> does **not** inherit your shell `PATH` on macOS, so a bare `"textstack-mcp"`
> often fails with "tool not found". Point at the installed binary directly:
> `~/.dotnet/tools/textstack-mcp` (macOS/Linux) or
> `%USERPROFILE%\.dotnet\tools\textstack-mcp.exe` (Windows).

```json
{
  "mcpServers": {
    "textstack": {
      "command": "/Users/you/.dotnet/tools/textstack-mcp",
      "env": {
        "TEXTSTACK_API_URL": "https://textstack.app/api",
        "TEXTSTACK_SITE_HOST": "textstack.app"
      }
    }
  }
}
```

Config file location:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

### 3. Restart Claude Desktop

Fully quit and reopen. The `textstack` server appears in the tools list. Try
*"search TextStack for books about distributed systems"* — that uses
`search_books` and needs no sign-in.

## Other clients

### Cursor / remote Claude — the hosted HTTP endpoint

No install needed. Point a streamable-HTTP MCP client at the hosted endpoint:

```
https://textstack.app/mcp
```

For user-scoped tools over HTTP, the bearer comes from the
`Authorization: Bearer <jwt>` header on each request — paste a device-flow JWT
(see [Authentication](#authentication)) into your client's connector config.
The remote host is multi-user: each connection authenticates with its own
bearer (there is no shared server-side token cache).

### ChatGPT custom connector

Add a custom MCP connector pointing at `https://textstack.app/mcp`. Public
tools work immediately; for user-scoped tools, supply a bearer token in the
connector's auth settings.

### Local, via the built DLL (running from source)

If you're hacking on the bridge from a checkout instead of the published tool:

```json
{
  "mcpServers": {
    "textstack": {
      "command": "dotnet",
      "args": ["/abs/path/backend/src/Ai/TextStack.Ai.Mcp/bin/Release/net10.0/TextStack.Ai.Mcp.dll"],
      "env": { "TEXTSTACK_API_URL": "https://textstack.app/api" }
    }
  }
}
```

Same stdio transport as the global tool.

## Authentication

Catalog tools (`search_books`, `get_book`, `get_chapter`) need no auth. The
user-scoped tools use the **OAuth 2.0 Device Authorization Grant**
([RFC 8628](https://www.rfc-editor.org/rfc/rfc8628)):

1. The first user-scoped tool call returns a clean message:
   *"authentication required — open https://textstack.app/device and enter code
   XXXX-XXXX to connect TextStack, then retry."*
2. Open [`https://textstack.app/device`](https://textstack.app/device) in a
   browser, sign in, enter the code, and approve.
3. The CLI's background poll picks up the approval and caches the token. Retry
   the tool call — it now succeeds.

The cached token is stored at `$XDG_CONFIG_HOME/textstack/mcp-token.json`,
falling back to `~/.textstack/mcp-token.json` (file mode `0600`, owner-only;
a group/world-readable cache is treated as compromised and ignored). The CLI
refreshes the access token itself and re-runs the device flow only when the
refresh token is gone.

This applies to the **local** (stdio) tool. For the **remote** (HTTP) endpoint,
there is no device flow on the server side — the bearer is supplied per request
by your client's connector config. Run the local tool once to obtain a JWT via
the device flow, then paste it into the remote client.

## Configuration

All configuration is environment-driven (set under `env` in your client config).

| Env var | Default | Purpose |
|---------|---------|---------|
| `TEXTSTACK_API_URL` | `https://textstack.app/api` | Base URL of the TextStack public API the bridge calls. |
| `TEXTSTACK_SITE_HOST` | `textstack.app` | `Host` header sent on each bridged request so the server resolves the site (needed for unauthenticated search). |
| `TEXTSTACK_MCP_TOKEN` | *(unset)* | Optional static bearer for user-scoped tools (CI / escape hatch). When set, it overrides the device flow. |
| `TEXTSTACK_MCP_TOKEN_CACHE` | *(see auth)* | Explicit file path for the device-flow token cache, overriding the default location. |
| `TEXTSTACK_MCP_TIMEOUT_SECONDS` | `15` | Upstream HTTP timeout per tool call. |
| `MCP_TRANSPORT` | `stdio` | Transport: `stdio` (local desktop client) or `http` (remote streamable HTTP host). The `--http` CLI flag also selects http. |

## Verify / smoke test

Before wiring up a client, confirm the tool speaks MCP. This sends
`initialize` → `notifications/initialized` → `tools/list` over stdio:

```bash
{ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'; sleep 1; printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'; printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'; sleep 4; } | textstack-mcp
```

Expect a response with `serverInfo` naming `textstack` and a `tools/list`
result containing all 14 tools.

## Troubleshooting

- **"Tool not found" in Claude Desktop** — GUI apps don't inherit your shell
  `PATH` on macOS. Use the absolute path to the binary (`~/.dotnet/tools/textstack-mcp`
  / `%USERPROFILE%\.dotnet\tools\textstack-mcp.exe`) as `command`.
- **`dotnet` not found** (when using the build-from-source DLL config) — same
  cause; point `command` at the absolute `dotnet` path, or prefer the installed
  global tool which is a self-contained launcher.
- **"authentication required — open .../device …"** — expected on the first
  user-scoped call. Approve at the device page and retry. Public tools never
  trigger this.
- **Update the tool**: `dotnet tool update -g TextStack.Mcp`
- **Uninstall**: `dotnet tool uninstall -g TextStack.Mcp`
- **Remote endpoint returns 401** — the request carried no/invalid bearer.
  The HTTP host has no device flow; supply a valid JWT in the client's
  connector config.

## Links

- Package (nuget.org): <https://www.nuget.org/packages/TextStack.Mcp>
- Landing page: <https://textstack.app/en/mcp>
- Discovery manifest: <https://textstack.app/.well-known/mcp/manifest.json>
- Source: `backend/src/Ai/TextStack.Ai.Mcp/`
</content>
</invoke>
