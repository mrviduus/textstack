# TextStack.Mcp

The **TextStack MCP server** — connect your [TextStack](https://textstack.app) reading
library to Claude Desktop, Cursor, or any [Model Context Protocol](https://modelcontextprotocol.io)
client. Search your books, discuss the chapters you share, and manage your highlights and
vocabulary straight from your AI assistant.

It exposes **18 tools**:

| Tool | What it does |
|------|--------------|
| `search_my_library` | Search your books by title or author (requires sign-in) |
| `get_my_book` | Fetch one of your uploads: metadata + chapter list (requires sign-in) |
| `save_my_highlight` | Highlight a passage in a book you uploaded (requires sign-in) |
| `list_my_book_highlights` | List the highlights in a book you uploaded (requires sign-in) |
| `save_insight` | Write a conclusion back into a book, against a chapter or the whole book (requires sign-in) |
| `get_my_insights` | Read back everything already worked out about a book (requires sign-in) |
| `list_my_vocabulary` | List your saved vocabulary words, with their ids (requires sign-in) |
| `add_vocabulary_words` | Save up to 20 words with translations to your vocabulary (requires sign-in) |
| `update_vocabulary_word` | Fix a saved word's translation or definition (requires sign-in) |
| `delete_vocabulary_word` | Remove one word from your vocabulary (requires sign-in) |
| `get_my_reading` | What you are reading now and every book — no arguments (requires sign-in) |
| `get_book_progress` | How far you have got in one book (requires sign-in) |
| `set_book_progress` | Record a chapter you finished, here or elsewhere (requires sign-in) |
| `share_chapter` | Snapshot one chapter for a discussion (requires sign-in) |
| `save_checkpoint` | Save one checkpoint of a discussion (requires sign-in) |
| `list_checkpoints` | Read a book's discussion checkpoints (requires sign-in) |
| `delete_checkpoint` | Delete one discussion checkpoint by id (requires sign-in) |
| `get_shared_chapter` | Read a chapter shared from the reader's Discuss (requires sign-in) |

## Install

```bash
dotnet tool install -g TextStack.Mcp
```

This installs the `textstack-mcp` command (.NET 11+; rolls forward to future majors).

On .NET 10+ you can also run it without installing:

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
client needs. Every tool works on your own account, and a book is identified by
its `bookId`.

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
