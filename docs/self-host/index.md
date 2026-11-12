# Self-hosting: where it stands

<img src="../assets/pixel-icons/self-host.svg" width="48" height="48" alt="">

**Short answer: TextStack runs on your own machine today. Running it as a public server is not
packaged yet.** This page says what works, what is missing and when that changes. Status as of
2026-11-11.

## What works today

Follow [Run TextStack locally](../start/run-locally.md). In about 20 minutes you have the backend in
Docker and the web app on a dev server, for one person on one machine. That setup gives you:

- Add EPUB and PDF books and read them.
- Highlights, vocabulary and reviews.
- Read aloud (text-to-speech). It needs no key.
- Guest use and email/password accounts.

Some features need a key of your own in `.env`
([all settings](../reference/environment-variables.md)):

- Explain and translate a word: `OPENAI_API_KEY`
- Sign in with Google: `GOOGLE_CLIENT_ID`
- Password reset emails: `RESEND_API_KEY`

The license is [AGPL-3.0](../../LICENSE). You may run and change TextStack. If you offer a changed
version to others over a network, you must publish your changes.

## What is missing for a real server

- **The web app is not a Docker service.** `docker compose up` starts the backend only. The web
  app runs from a dev server, or you build it and serve the files yourself.
- **There is no ready web server setup.** The one in the repository is written for the project's
  own addresses. Nothing sets up HTTPS for yours.
- **There are no builds made for others.** You build from source, and there are no numbered
  releases to stay on.
- **Backups and updates are tied to one server.** They target the project's own machine.
- **The data is about to change.** V2 moves it to a new database in one step. A guide written now
  would be wrong after that.

You can work around each of these if you know Docker and nginx. We do not document that path,
because we cannot promise it keeps working until V2 is done.

## When this changes

A full self-hosting guide comes after the V2 cutover, once the web app runs from
`docker compose`. Progress: [STATUS.md](../STATUS.md) and
[issue #1013](https://github.com/mrviduus/textstack/issues/1013).

## Next

[Run TextStack locally](../start/run-locally.md).
