# TextStack

[![Web](https://img.shields.io/badge/Web-textstack.app-2ea44f?logo=googlechrome&logoColor=white)](https://textstack.app)
[![Google Play](https://img.shields.io/badge/Android-Google%20Play-3DDC84?logo=googleplay&logoColor=white)](https://play.google.com/store/apps/details?id=app.textstack.mobile)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

Free reader for real books. Look up and explain what you don't understand, discuss it with your own AI assistant, save what you learn back into the book.

<p align="center">
  <img src="docs/demo.gif" alt="TextStack: select a phrase in the reader, get a short contextual explanation" width="800">
</p>

## Get TextStack

- **Web**: [textstack.app](https://textstack.app). Sample chapters open without signup.
- **Android**: [Google Play](https://play.google.com/store/apps/details?id=app.textstack.mobile).
- **Self-host**: see [Run locally](#run-locally).

## Features

| Feature | Description |
|---|---|
| **Library and uploads** | Browse the catalog, or upload your own EPUB / PDF and read it after parsing. |
| **Kindle-like reader** | Themes, fonts, fullscreen, keyboard shortcuts, bookmarks, highlights, reading stats. |
| **Explain and translate** | Select a phrase and get a short explanation or translation that takes the book's context into account. |
| **Vocabulary review** | Words you look up are saved with their sentence and reviewed with spaced repetition. |
| **Read aloud** | Text-to-speech with adjustable speed. |
| **Offline and sync** | Download books for offline reading on web and Android; progress syncs across devices. |
| **AI assistant (MCP)** | Connect your own AI assistant to your library. See below. |

## Read with your AI assistant

TextStack is a [Model Context Protocol](https://modelcontextprotocol.io) server, so an assistant you already use (Claude, ChatGPT, Cursor) can work with your books:

1. **Read**: the assistant searches your library and reads the chapter you are on.
2. **Discuss**: ask about the chapter, an argument or a hard passage.
3. **Save back**: conclusions go into the book as insights, highlights, chapter reviews and vocabulary. Chapter reviews and vocabulary are saved only after you say yes.

Setup, tools and auth: [docs/05-features/mcp.md](docs/05-features/mcp.md).

## Run locally

Prerequisites: Docker, pnpm, Node.js ([.nvmrc](.nvmrc)) and the .NET SDK for the target in [Directory.Build.props](Directory.Build.props) (only needed outside Docker).

```bash
git clone https://github.com/mrviduus/textstack
cd textstack
cp .env.example .env     # fill POSTGRES_PASSWORD and JWT_SECRET (32+ chars); OPENAI_API_KEY enables AI features
make up                  # backend services in Docker (builds on first run)
pnpm install
pnpm -C apps/web dev     # web is not a compose service
```

| Service | URL |
|---|---|
| Web | http://localhost:5173 |
| API | http://localhost:8080 ([Scalar docs](http://localhost:8080/scalar/v1)) |
| Admin | http://localhost:81 |

Tests, migrations, mobile and the rest: [docs/03-ops/local-dev.md](docs/03-ops/local-dev.md) and [CLAUDE.md](CLAUDE.md).

## Documentation

- [Docs index](docs/README.md) and [architecture](docs/01-architecture/README.md)
- [Deployment](docs/03-ops/deployment.md), [backup and restore](docs/03-ops/backup.md), [incident runbook](docs/03-ops/incident-runbook.md)
- [Changelog](CHANGELOG.md)

## Contributing

Bug reports, ideas and PRs are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first, or [open an issue](https://github.com/mrviduus/textstack/issues/new/choose).

## License

[GNU AGPL v3.0](LICENSE) © 2026 Vasyl Vdovychenko. Free to use, modify and self-host. If you run a modified version as a network service, you must publish your changes under the same license.

A commercial license is available for organizations that cannot use AGPL (proprietary forks, hosted commercial services). Contact: mrviduus@gmail.com.

- Standard Ebooks corpus in seed data: CC0 / public domain
- Edge TTS: used under Microsoft's Edge Read Aloud terms
- Third-party dependencies: their respective licenses
