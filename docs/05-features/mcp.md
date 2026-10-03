# MCP server — connect TextStack to your AI client

TextStack is a **Model Context Protocol (MCP)** server. Connect it to Claude
Desktop, Cursor, ChatGPT, or any MCP client, and the assistant can search the
TextStack library, read chapters, ask grounded questions about a book you're
reading, and manage your own highlights and vocabulary — all from the chat.

This is the canonical reference. The [package README](https://www.nuget.org/packages/TextStack.Mcp)
and the [landing page](https://textstack.app/en/mcp) point here.

## The 21 tools

The server exposes 21 tools. The public ones need no auth; the user-scoped ones
require you to be signed in (see [Authentication](#authentication)).

**Two halves, two identifiers.** The public catalog is made of `Edition`s and is
addressed by `editionId`. The books you uploaded are `UserBook`s — a separate
aggregate, with its own chapter table — and are addressed by `bookId`.
An upload has no `editionId` and cannot be given one. Passing a `bookId` to
`list_my_highlights` returns an empty list, which reads like an empty library
rather than a wrong id. The tool names carry the split: `_my_` means your
uploads.

| Tool | What it does | Auth |
|------|--------------|------|
| `search_books` | Search the public library for books and chapters matching a query. | Public |
| `get_book` | Fetch a catalog book by slug: its `editionId`, metadata, authors, genres, and chapter list. | Public |
| `get_chapter` | Fetch a chapter's plain text (HTML stripped, length-capped) plus its number, title, and prev/next slugs. | Public |
| `search_my_library` | Full-text search across the books **you uploaded**. Returns one hit per book with its `bookId` and best-matching chapter. | User |
| `get_my_book` | Fetch one of your uploads by `bookId`: metadata + full chapter list, each chapter carrying its `chapterId`. | User |
| `get_my_chapter` | Fetch one chapter of your upload as plain text, plus its `chapterId` and prev/next slugs. | User |
| `save_my_highlight` | Highlight a passage in a book you uploaded. Matched against the chapter text, so the quote must be verbatim. Capped at 200 per book. | User |
| `list_my_book_highlights` | List the highlights already in a book you uploaded. | User |
| `save_insight` | Write a conclusion back into a book — against a `chapterSlug`, or against the whole book when omitted. Saving again for the same chapter replaces it. | User |
| `get_my_insights` | Read back everything already worked out about a book, in reading order. | User |
| `list_my_highlights` | List your highlights for a given edition. | User |
| `list_my_vocabulary` | List your saved vocabulary words, optionally filtered by SRS stage or search. Each carries its `id`. | User |
| `add_vocabulary_words` | Save up to 20 words (word, language, native-language translation, optional definition + sentence), optionally linked to a `bookId` or `editionId`. One result line per word (added / already saved / queued / reference only); a refused word does not stop the batch, a 429 does. Rows are tagged `source = mcp` server-side. | User |
| `update_vocabulary_word` | Change a saved word's translation and/or definition by `id`. | User |
| `delete_vocabulary_word` | Delete one saved word by `id`. No bulk delete — and `DELETE /me/vocabulary/words` (wipe all) refuses OAuth tokens. | User |
| `save_highlight` | Save a passage (text + optional color/note) to your highlights for a catalog book chapter. | User |
| `get_my_reading` | The shelf, with no arguments: what you are reading now, what you finished recently, every upload. The only tool that needs no id — it is how the assistant finds one. | User |
| `get_book_progress` | How far you have got in one book, and the chapter you stopped in. | User |
| `set_book_progress` | Record that you finished a chapter — including one you read or listened to somewhere else. | User |
| `get_chapter_review` | Start a chapter review in one call: the review method, the chapter text (in parts if long), your highlights and saved words, open threads from earlier chapters. Refuses a chapter you have not reached. | User |
| `save_chapter_review` | Save the structured review into the chapter's insight; its questions get their own spaced-repetition queue. A refusal lists every problem at once. See [chapter-review.md](chapter-review.md). | User |

All 21 tools are always listed regardless of whether you're signed in — only a
user-scoped *call* fails with a clean "authentication required" message when no
token is available.

**Where the reader is.** `get_my_reading` takes no arguments and is the entry point:
it answers "what am I reading" with titles, the chapter you stopped in, and the id
each other tool takes — `bookId` for an upload, `editionId` *and* `slug` for a catalog
book. `get_book_progress` answers the same for one book, which is what lets an
assistant avoid spoiling what you have not reached. `set_book_progress` closes the
loop the other way: tell it you finished a chapter in an audiobook or on paper and
the app resumes you at the next one, with progress recorded as chapters-finished
over chapters-total. It is the only tool here that changes where your reader opens,
so it acts only when you say you finished something.

A typical catalog chain is `search_books → get_book` (to get the `editionId` /
chapter ids) `→ get_chapter` / `save_highlight`. The chain for your own uploads
is `search_my_library → get_my_book` (to get the chapter ids) `→ get_my_chapter`.

**There is no question-answering tool.** There used to be — `ask_book`, a
retrieval-augmented answer over an index we built and paid for. It is gone,
because your assistant reads `get_chapter` as plain text and reasons over it
better than our retrieval did, at no cost to us and none to you beyond the
subscription you already have. Ask it about the chapter; it has the chapter.

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

## Server instructions — the "how to work" rules live on the server

Both transports send `instructions` at `initialize` (`McpBridgeCore.Instructions`,
wired as `McpServerOptions.ServerInstructions` in both hosts). They tell the model:
find the book (from the id line, else `search_my_library` / `get_my_reading`),
check `get_my_insights` first, read with `get_my_book`/`get_my_chapter` (catalog:
`get_book`/`get_chapter`), save conclusions with `save_insight`, run a chapter review
via `get_chapter_review` → `save_chapter_review`, and never run ahead of the
reader's position.

That is why the Discuss and Review buttons prefill only a human sentence plus an
id line — the reader sees that message:

```
Let's discuss "AI Engineering" by Chip Huyen in TextStack.

(TextStack: book a1751e58-25f1-496d-b571-1041f0a31e62)
```

Id line vocabulary: `book <bookId>` (upload), `catalog <slug>, edition <editionId>`
(catalog book — read tools take the slug, insight tools the editionId),
`chapter <chapterSlug>` (review). Builders: `packages/shared/src/lib/assistantHandoff.ts`,
`chapterReview.ts`. Pinned by `Initialize_OverWire_ReturnsServerInstructionsNamingTheWorkflowTools`.

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

Clients that speak MCP OAuth (claude.ai, Claude Desktop/mobile, Claude Code, ChatGPT) need nothing
else: paste the URL, sign in to TextStack, approve — see [Authentication](#authentication). Every
request to `/mcp` needs a bearer; without one the host answers `401`.

Clients that don't do OAuth send a **connect key** as `Authorization: Bearer tsk_…` on each request. Create one on
[textstack.app/en/mcp](https://textstack.app/en/mcp) (or the app's *Connect assistant* screen);
it does not expire and is revoked there. A device-flow JWT (see
[Authentication](#authentication)) also works but expires within the hour. The remote host is
multi-user: each connection authenticates with its own bearer (there is no shared server-side
token cache).

### ChatGPT (and any client that can't send a header) — the personal connect URL

ChatGPT's connector settings offer "No authentication" or OAuth, and nothing that sends a bearer.
With OAuth (ADR-017) the plain `https://textstack.app/mcp` + **OAuth** is the way in; for anything
that can do neither, the key goes **in the URL**:

```
https://textstack.app/mcp/k/tsk_…
```

Creating a key on the connect page shows this URL next to the Claude Desktop config, with a Copy
button. In ChatGPT, add a custom connector (Developer mode), paste the URL, and choose
**No authentication**.

How it works: the MCP host rewrites `/mcp/k/<key>` to `/mcp` with `Authorization: Bearer <key>`
(`backend/src/Ai/TextStack.Ai.Mcp/Auth/ConnectUrl.cs`) before routing, so from there on it is the
ordinary bearer path — same key, same instant revocation. A malformed key is a 404, never an
anonymous session. An explicit `Authorization` header wins over the URL.

**The URL is a password.** Anyone holding it reads and writes the library as you until the key
is revoked. What we do to keep it out of logs:

- the MCP host logs `Microsoft.AspNetCore.Hosting.Diagnostics` and `…Routing` at Warning, so the
  per-request "Request starting …" line (written before any middleware) never records the path;
- nginx has `access_log off` and `error_log … crit` for `location /mcp/k/`.

Not covered: **Cloudflare**, in front of both, sees the full URL. Accepted until OAuth.

Not yet verified by hand (owner step): whether Developer mode is available on the account's
ChatGPT plan, and what ChatGPT asks before a write call (`save_highlight`, `save_insight`). Record
the answer here.

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

### Remote endpoint — OAuth 2.1 (ADR-017)

The hosted `https://textstack.app/mcp` requires a bearer on **every** request, catalog tools
included. Three kinds are accepted: an OAuth access token (`tso_…`), a connect key (`tsk_…`, header or
`/mcp/k/<key>`), or a device-flow JWT. [ADR-017](../01-architecture/adr/ADR-017-mcp-oauth-authorization-server.md)
has the why.

```
POST /mcp (no bearer)                         → 401  WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp", scope="library"
GET  /.well-known/oauth-protected-resource/mcp → {resource: https://textstack.app/mcp, authorization_servers: [https://textstack.app]}   (MCP host)
GET  /.well-known/oauth-authorization-server   → RFC 8414 metadata: S256, auth method "none", CIMD + DCR, iss param   (API)
POST /oauth/register                           → DCR, public client (or: client_id is a CIMD https URL, fetched + cached 24 h)
GET  /oauth/authorize?…&code_challenge&resource → 302 /en/oauth/consent?req=<id>
GET  /oauth/requests/{id}                      → {clientName, redirectHost, scope, scopeDescription, status}
POST /oauth/authorize/approve {requestId}      → {redirect: <redirect_uri>?code&state&iss}   (web sign-in; guest → 403 account_required)
POST /oauth/authorize/deny {requestId}         → {redirect: <redirect_uri>?error=access_denied&state&iss}
POST /oauth/token (form)                       → tso_ (1 h) + tsr_ (90 d sliding, rotated each use)
POST /oauth/revoke (form, RFC 7009)            → 200 always
GET  /me/oauth/grants · DELETE /me/oauth/grants/{id}   → "Connected apps"; revoke is effective on the next request
```

- Redirect hosts: `OAuth:AllowedRedirectHosts` (claude.ai, claude.com, chatgpt.com) over https, or
  loopback on any port. Anything else is refused at register and at authorize.
- A `tso_` token is **library-only**: account management (`/me/account`, `/me/profile`, `/auth/*`,
  `/me/mcp/keys`, `/me/oauth/grants`, OAuth approve/deny) answers `403 insufficient_scope`.
- Reconnecting the same app (same name + redirect host) replaces its previous grant. Reusing a
  rotated refresh token revokes the whole grant.
- An expired or revoked `tso_` is answered by the MCP host with `401 error="invalid_token"` (it asks
  the API's `GET /oauth/token-status`), which is what makes a client refresh.
- Rate limits, per IP: `oauth-browser` 30/min (authorize, consent), `oauth-server` 120/min (token,
  register, revoke — sized for a whole platform's egress IP).
- The MCP host needs `TEXTSTACK_PUBLIC_URL` only if the site is not `https://textstack.app`; it must
  equal the API's `App:BaseUrl`.

### Local tool — device flow

The user-scoped tools of the **local** (stdio) tool use the **OAuth 2.0 Device Authorization Grant**
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

This applies to the **local** (stdio) tool only; the remote endpoint uses OAuth (above).

## Configuration

All configuration is environment-driven (set under `env` in your client config).

| Env var | Default | Purpose |
|---------|---------|---------|
| `TEXTSTACK_API_URL` | `https://textstack.app/api` | Base URL of the TextStack public API the bridge calls. |
| `TEXTSTACK_SITE_HOST` | `textstack.app` | `Host` header sent on each bridged request so the server resolves the site (needed for unauthenticated search). |
| `TEXTSTACK_MCP_TOKEN` | *(unset)* | Optional static bearer for user-scoped tools (CI / escape hatch). When set, it overrides the device flow. |
| `TEXTSTACK_MCP_TOKEN_CACHE` | *(see auth)* | Explicit file path for the device-flow token cache, overriding the default location. |
| `TEXTSTACK_MCP_TIMEOUT_SECONDS` | `15` | Upstream HTTP timeout per tool call. |
| `TEXTSTACK_PUBLIC_URL` | `https://textstack.app` | http mode: OAuth issuer + MCP resource URL advertised in the 401 challenge and protected-resource metadata. Must equal the API's `App:BaseUrl`. |
| `MCP_TRANSPORT` | `stdio` | Transport: `stdio` (local desktop client) or `http` (remote streamable HTTP host). The `--http` CLI flag also selects http. |

## Verify / smoke test

Before wiring up a client, confirm the tool speaks MCP. This sends
`initialize` → `notifications/initialized` → `tools/list` over stdio:

```bash
{ printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"1"}}}'; sleep 1; printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized"}'; printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'; sleep 4; } | textstack-mcp
```

Expect a response with `serverInfo` naming `textstack` and a `tools/list`
result containing all 21 tools.

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
