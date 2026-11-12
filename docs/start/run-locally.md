# Run TextStack locally

You get: TextStack running on your machine, with a book open on the reading screen.

Time: about 20 minutes. Most of it is the first build.

## Before you start

- [Docker](https://docs.docker.com/get-docker/) is running.
- You have `git`, `make`, Node.js (the version in [`.nvmrc`](../../.nvmrc)) and [pnpm](https://pnpm.io/installation).
- Ports 8080, 81 and 5173 are free.

## How it is set up

Two parts run in two places.

- The **backend** runs in Docker. It keeps the books and answers the app.
- The **web app** runs on your machine. When you change it, you see the change at once.

## The three lessons

1. [Get the code](run-1-get-the-code.md): clone, settings, data folders.
2. [Start it](run-2-start-it.md): the backend, the database, the web app.
3. [Open a book](run-3-open-a-book.md): add a book and read its first page.

Each lesson ends with a short list to tick. The site remembers your ticks in this browser.

## Where things are, once it runs

- Web app: <http://localhost:5173>
- API: <http://localhost:8080>
- API reference: <http://localhost:8080/scalar/v1>
- Admin panel: <http://localhost:81>

To stop the backend, run `make down`. Your data stays in `./data`.

Database changes: [`database/README.md`](../../database/README.md). All settings:
[environment variables](../reference/environment-variables.md).

## Next

[Lesson 1: Get the code](run-1-get-the-code.md).
