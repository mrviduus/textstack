# Self-hosting: where it stands

<img src="../assets/pixel-icons/self-host.svg" width="48" height="48" alt="">

**Short answer: TextStack runs on your own machine today. Running it as a public server is not
packaged yet.** This page says what works, what is missing and when that changes. Status as of
2026-11-11.

## What works today

Follow [Run TextStack locally](../start/run-locally.md). In about 20 minutes you have the backend in
Docker and the web app on a dev server, for one person on one machine. That setup gives you:

- Upload EPUB and PDF files and read them.
- Highlights, saved words and vocabulary review.
- Read aloud (text-to-speech). It needs no key.
- Guest use and email/password accounts.

Some features need a key of your own in `.env`
([all settings](../reference/environment-variables.md)):

| Feature | Setting |
|---|---|
| Explain and translate | `OPENAI_API_KEY` |
| Sign in with Google | `GOOGLE_CLIENT_ID` |
| Password reset emails | `RESEND_API_KEY` |

The license is [AGPL-3.0](../../LICENSE). You may run and change TextStack. If you offer a changed
version to others over a network, you must publish your changes.

## What is missing for a real server

| Missing | Detail |
|---|---|
| The web app is not a Docker service | `docker compose up` starts the backend only. The web app runs from a dev server, or you build it and serve the files yourself. |
| No ready reverse proxy | The nginx configuration in the repository is written for the project's own domains and paths. Nothing sets up HTTPS for your domain. |
| No images or releases meant for others | CI builds images for the project's own deploy only. You build from source, and there are no versioned releases to pin. |
| Backups and updates are tied to one server | The backup and deploy workflows target the project's own server. |
| The data model is about to change | V2 moves the data to a new database with one cutover. A guide written now would be wrong after it. |

You can work around each of these if you know Docker and nginx. We do not document that path,
because we cannot promise it keeps working until V2 is done.

## When this changes

A full self-hosting guide comes after the V2 cutover, once the web app runs from
`docker compose`. Progress: [STATUS.md](../STATUS.md) and
[issue #1013](https://github.com/mrviduus/textstack/issues/1013).

## Next

[Run TextStack locally](../start/run-locally.md).
