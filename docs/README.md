# TextStack docs

TextStack is a free reading app: upload a book, read it on the web or on Android, save words, talk
about a chapter with your AI assistant. These pages are for people who run the code or change it.
Readers find help inside the app at [textstack.app](https://textstack.app/).

## What do you want to do?

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="start/run-locally.md"><img src="assets/pixel-icons/start-here.svg" width="48" height="48" alt=""></a>
      <h3><a href="start/run-locally.md">Run it locally</a></h3>
      From a clone to the app running on your machine with Docker.
    </td>
    <td width="50%" valign="top">
      <a href="../.github/CONTRIBUTING.md"><img src="assets/pixel-icons/contribute.svg" width="48" height="48" alt=""></a>
      <h3><a href="../.github/CONTRIBUTING.md">Ship a first PR</a></h3>
      Branch, change, checks, area label, pull request.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <img src="assets/pixel-icons/self-host.svg" width="48" height="48" alt="">
      <h3>Self-host</h3>
      It runs locally today. Production self-hosting is not packaged yet; a status page is coming
      (<a href="https://github.com/mrviduus/textstack/issues/1237">#1237</a>).
    </td>
    <td width="50%" valign="top">
      <a href="architecture/index.md"><img src="assets/pixel-icons/architecture.svg" width="48" height="48" alt=""></a>
      <h3><a href="architecture/index.md">Understand the architecture</a></h3>
      The services, how a book moves through them, and why they are built this way.
    </td>
  </tr>
</table>

## Where the project is now

TextStack is moving to **V2**: a second database, a new reader, one cutover. Part of it is live and
part is behind a flag.

- [STATUS.md](STATUS.md): what is in flight, what is known broken, what we decided not to do.
- [V2 architecture](architecture/v2.md): the map of V2 and its boundaries.
- [Changelog](https://textstack.app/en/changelog): merged pull requests by week.

## Architecture

| Page | What it answers |
|---|---|
| [Overview](architecture/index.md) | Which services exist and what each one does |
| [Flows](architecture/flows.md) | How a request moves between them, one diagram per scenario |
| [Data model](architecture/data-model.md) | Every table: purpose, status, personal data |
| [Data access](architecture/data-access.md) | The rules for repositories and SQL |
| [Frontend](architecture/frontend.md) | The apps and the shared packages |
| [Delivery](architecture/delivery.md) | How a commit reaches production |
| [Decisions (ADRs)](architecture/adr/) | Why each load-bearing choice was made; read the status line first |

## Guides

- [Write and run end-to-end tests](guides/e2e-tests.md)

## Reference

- [Environment variables](reference/environment-variables.md)
- [MCP server](reference/mcp.md): connect TextStack to an AI assistant
- API reference: generated from the code. Run the app, then open `http://localhost:8080/scalar/v1`.

## Rules for these docs

- A change to a command, an environment variable, a route, a flag or a setup step edits the page
  that states it, in the same pull request.
- One home per fact. The API reference and the changelog are generated, never written by hand.
- A new decision that is hard to reverse, or that touches several modules, gets an
  [ADR](architecture/adr/).
- Links are checked in CI: `node scripts/check-doc-links.mjs`.

## Internal notes

[`internal/`](internal/) holds the maintainer's working material: operations of the production
server, incident postmortems, V2 design drafts, feature specs, QA reports, the frozen changelog
archive and `legacy/` (what the V2 cutover removes). It is public, but not written for a first read.
