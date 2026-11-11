# Run TextStack locally

You get: TextStack running on your machine, with a book you uploaded open in the reader. Time: about
20 minutes, most of it the first build. Before you start: [Docker](https://docs.docker.com/get-docker/)
is running, and you have `git`, `make`, Node.js (the version in [`.nvmrc`](../../.nvmrc)) and
[pnpm](https://pnpm.io/installation). Ports 8080, 81 and 5173 are free.

Two parts run in different places. The **backend** (API, worker, database) runs in Docker. The
**web app** runs on your machine with a dev server, so your changes show up at once.

## Steps

1. **Clone the repository.**

   ```bash
   git clone https://github.com/mrviduus/textstack
   cd textstack
   ```

2. **Create your settings file.** `.env` holds the settings Docker reads.

   ```bash
   cp .env.example .env
   ```

3. **Edit four lines in `.env`.**

   ```bash
   POSTGRES_PASSWORD=local-dev-password
   JWT_SECRET=local-dev-secret-at-least-32-characters
   ASPNETCORE_ENVIRONMENT=Development
   FEATURES_V2API=true
   ```

   `JWT_SECRET` signs the sign-in tokens and must be 32 characters or longer. `FEATURES_V2API=true`
   turns on V2, the new library and reader the project is moving to. Leave the other lines as they are.

4. **Create the data folders.** The backend keeps books and caches in `./data`.

   ```bash
   make fix-permissions
   ```

   You should see: `Done.`

5. **Start the backend.** The first run builds five images and downloads about 3 GB.

   ```bash
   make up
   ```

   You should see: `Container textstack_api_prod  Healthy` near the end.

6. **Create the V2 database.** `make up` does not do this.

   ```bash
   make migrate-v2
   ```

   You should see: a list of `up: …` lines, then `Done.`

7. **Check the backend.** Wait 30 seconds after step 6, then:

   ```bash
   curl http://localhost:8080/health/ready
   ```

   You should see: `"status":"ready"` and `"v2":{"status":"ok"}`.

8. **Start the web app.**

   ```bash
   pnpm install
   pnpm -C apps/web dev
   ```

   You should see: `Local: http://localhost:5173/`. Keep this terminal open.

9. **Upload a book.** Open <http://localhost:5173>. Click **Upload your book** and choose an EPUB
   file. The repository has one: `tests/TextStack.Extraction.Tests/Fixtures/frankenstein.epub`. You
   do not need an account; the app signs you in as a guest.

   You should see: the book's page, with its chapters listed.

10. **Open the book.** Click **Open in the V2 reader**.

## It worked when

The first page of the book is on your screen, at an address that ends in `/read-v2`.

To stop the backend: `make down`. Your data stays in `./data`.

## Troubleshooting

| What you see | Why | What to do |
|---|---|---|
| `make up` fails with `port is already allocated` | Another program uses port 8080 or 81. | Stop that program, then run `make up` again. |
| `"v2":{"status":"unreachable"}` in step 7 | The V2 database does not exist yet, or the API has not looked again. It looks every 30 seconds. | Run `make migrate-v2`, wait 30 seconds, check again. |
| **Upload failed** next to the upload button | The web app cannot reach the API. The API answers only a web app on port 5173. | Check step 7. Check the dev server says port 5173; if it chose another port, stop what uses 5173 and start it again. |
| There is no **Open in the V2 reader** link | `FEATURES_V2API` was not `true` when the backend started. | Fix `.env`, then run `docker compose up -d --force-recreate api worker`. A plain restart does not read `.env` again. |

## Where things are

| What | Address |
|---|---|
| Web app | <http://localhost:5173> |
| API | <http://localhost:8080> |
| API reference | <http://localhost:8080/scalar/v1> |
| Admin panel | <http://localhost:81> |

Database changes: [`database/README.md`](../../database/README.md). All settings:
[environment variables](../reference/environment-variables.md).

## Next

[Ship a first pull request](first-pr.md).
