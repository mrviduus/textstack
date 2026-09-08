# TextStack.Mcp

The **TextStack MCP server** — connect your [TextStack](https://textstack.app) reading
library to Claude Desktop, Cursor, or any [Model Context Protocol](https://modelcontextprotocol.io)
client. Ask your books questions, read chapters, and manage your highlights and
vocabulary straight from your AI assistant.

It exposes **14 tools**:

| Tool | What it does |
|------|--------------|
| `search_books` | Search the public book catalog by query |
| `get_book` | Fetch a book's metadata and chapter list by slug |
| `get_chapter` | Fetch the full text of a single chapter |
| `ask_book` | Ask a question about a book and get a cited, grounded answer |
| `search_my_library` | Search the books **you uploaded** (requires sign-in) |
| `get_my_book` | Fetch one of your uploads: metadata + chapter list (requires sign-in) |
| `get_my_chapter` | Fetch the full text of one chapter of your upload (requires sign-in) |
| `save_my_highlight` | Highlight a passage in a book you uploaded (requires sign-in) |
| `list_my_book_highlights` | List the highlights in a book you uploaded (requires sign-in) |
| `save_insight` | Write a conclusion back into a book, against a chapter or the whole book (requires sign-in) |
| `get_my_insights` | Read back everything already worked out about a book (requires sign-in) |
| `list_my_highlights` | List your saved highlights (requires sign-in) |
| `save_highlight` | Save a passage to your highlights (requires sign-in) |
| `list_my_vocabulary` | List your saved vocabulary words (requires sign-in) |

## Install

```bash
dotnet tool install -g TextStack.Mcp
```

This installs the `textstack-mcp` command (.NET 10+; rolls forward to future majors).

On .NET 10 you can also run it without installing:

```bash
dnx textstack-mcp
```

## Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "textstack": {
      "command": "textstack-mcp",
      "env": {
        "TEXTSTACK_API_URL": "https://textstack.app/api",
        "TEXTSTACK_SITE_HOST": "textstack.app"
      }
    }
  }
}
```

The server speaks MCP over **stdio** by default — exactly what a local desktop
client needs. The catalog tools (`search_books`, `get_book`, `get_chapter`) work
without signing in.

Your own uploads are a separate half of the library, reached by the `*_my_*`
tools and identified by a `bookId`. A `bookId` is not an `editionId`: passing one
to `ask_book` or `list_my_highlights` returns nothing rather than an error, so
keep the two apart.

## Auth (for your highlights / vocabulary)

The first user-scoped tool call returns a message like
*"authentication required — open https://textstack.app/device and enter code XXXX-XXXX"*.
Open the device page, sign in, enter the code, then retry the call.

## Remote option (no install)

Prefer not to run anything locally? Point a Streamable-HTTP MCP client at the
hosted endpoint instead:

```
https://textstack.app/mcp
```

More: **https://textstack.app/en/mcp**

## License

AGPL-3.0-or-later.
