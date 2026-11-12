# TextStack docs

TextStack is a library you carry with you. You add a book, read it on the web or on Android, save
the words you do not know, and talk about a chapter with your AI assistant.

These pages are for people who run TextStack or change it. If you only want to read books, the app
is at [textstack.app](https://textstack.app/).

## Start with the stories

Eight short stories say how people use TextStack. No code, no technical names. Read them first: the
words in them are the words of the whole project.

- [The stories of TextStack](stories/index.md)
- [The words of TextStack](glossary.md): one word for one thing, and the list of areas.

## What do you want to do?

<table>
  <tr>
    <td width="50%" valign="top">
      <a href="start/run-locally.md"><img src="assets/pixel-icons/start-here.svg" width="48" height="48" alt=""></a>
      <h3><a href="start/run-locally.md">Run it locally</a></h3>
      Three short lessons, from a copy of the code to a book open on your screen.
    </td>
    <td width="50%" valign="top">
      <a href="start/first-pr.md"><img src="assets/pixel-icons/contribute.svg" width="48" height="48" alt=""></a>
      <h3><a href="start/first-pr.md">Ship a first PR</a></h3>
      Three short lessons: pick the work, change and check, open the pull request.
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <a href="self-host/index.md"><img src="assets/pixel-icons/self-host.svg" width="48" height="48" alt=""></a>
      <h3><a href="self-host/index.md">Self-host</a></h3>
      It runs locally today. Production self-hosting is not packaged yet: what works, what is missing.
    </td>
    <td width="50%" valign="top">
      <a href="architecture/index.md"><img src="assets/pixel-icons/architecture.svg" width="48" height="48" alt=""></a>
      <h3><a href="architecture/index.md">See how it works</a></h3>
      The parts of TextStack and how a book moves between them.
    </td>
  </tr>
</table>

## Look something up

- [Settings](reference/environment-variables.md): every environment variable.
- [Connect an AI assistant](reference/mcp.md).
- [End-to-end tests](guides/e2e-tests.md): write and run them.
- [The data](architecture/data-model.md) and [the rules for reading and writing it](architecture/data-access.md).
- [Decisions](architecture/adr/): why each big choice was made. Read the status line of a decision first.

## Where the project is now

TextStack is moving to **V2**: a new library and a new reading screen. Part of it is live, part is
still switched off.

- [The move to V2](architecture/v2.md).
- [What changed, week by week](https://textstack.app/en/changelog).
- [Status](STATUS.md): what is being worked on and what is known to be broken.

## Rules for these docs

- A change to a command, a setting, a route or a setup step edits the page that states it, in the
  same pull request.
- One home for each fact.
- Plain words. The [glossary](glossary.md) has the word for each thing; use that word.
- Links are checked by CI: `node scripts/check-doc-links.mjs`.

The maintainer's working notes are not part of these docs. They live in
[`internal/`](../internal/) at the top of the repository.
